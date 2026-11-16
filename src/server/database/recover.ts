import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join } from "node:path";
import { isIP } from "node:net";
import { readPrivateDatabaseFile } from "./config.js";
import { databaseIdentifier } from "./management/state.js";
import type { DatabaseHostRecoveryMarker } from "./management/host-recovery.js";
import { serverTranslator } from "../i18n/messages.js";
import type { MessageId } from "../../shared/i18n/messages.js";
import { REQUIRED_LOCALE_CODES } from "../../shared/i18n/locale-policy.js";

const locales: readonly string[] = REQUIRED_LOCALE_CODES;
const capability = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
class RecoveryCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface DatabaseRecoveryCommandOptions {
  stateRoot: string;
  url: string;
  output: string;
  retry: boolean;
}
interface SavedCapability {
  operationId: string;
  statusToken: string;
}
function loopbackUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RecoveryCommandError("hostRecoveryArguments");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127.")))
  )
    throw new RecoveryCommandError("hostRecoveryArguments");
  return url;
}
async function privateDirectory(path: string, privateMode = true) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (privateMode && process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new RecoveryCommandError("hostRecoveryPrivateFile");
}
async function privateJson<T>(path: string): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o777) !== 0o600))
    throw new RecoveryCommandError("hostRecoveryPrivateFile");
  return JSON.parse((await readPrivateDatabaseFile(path, 4096)).toString("utf8"));
}
async function savedCapability(path: string): Promise<SavedCapability | null> {
  try {
    await privateDirectory(dirname(path));
    const saved = await privateJson<SavedCapability>(path);
    if (!databaseIdentifier(saved.operationId) || !capability(saved.statusToken))
      throw new RecoveryCommandError("hostRecoveryPrivateFile");
    return saved;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
async function saveCapability(path: string, operationId: string): Promise<SavedCapability> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await privateDirectory(dirname(path));
  const previous = await savedCapability(path);
  if (previous) {
    if (previous.operationId !== operationId) throw new RecoveryCommandError("hostRecoveryOperationChanged");
    return previous;
  }
  const saved = { operationId, statusToken: randomBytes(32).toString("base64url") };
  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const winner = await savedCapability(path);
    if (!winner || winner.operationId !== operationId) throw new RecoveryCommandError("hostRecoveryOperationChanged");
    return winner;
  }
  try {
    await file.writeFile(JSON.stringify(saved));
    await file.sync();
  } finally {
    await file.close();
  }
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  return saved;
}
/** Node HTTP uses no environment proxy and follows no redirects; secrets stay on the explicitly selected loopback socket. */
async function call(base: URL, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = (base.protocol === "https:" ? httpsRequest : httpRequest)(
      new URL(path, base),
      {
        method: bytes ? "POST" : "GET",
        agent: false,
        headers: {
          origin: base.origin,
          accept: "application/json",
          ...headers,
          ...(bytes ? { "content-type": "application/json", "content-length": String(bytes.length) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65536) request.destroy(new RecoveryCommandError("hostRecoveryFailed"));
          else chunks.push(chunk);
        });
        response.on("error", () => reject(new RecoveryCommandError("hostRecoveryUnconfirmed")));
        response.on("end", () => {
          let value: unknown;
          try {
            value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new RecoveryCommandError("hostRecoveryUnconfirmed"));
            return;
          }
          if (response.statusCode !== 200) {
            const code = (value as { error?: { code?: unknown } })?.error?.code;
            reject(
              new RecoveryCommandError(
                typeof code === "string" && /^[a-zA-Z]{1,64}$/.test(code) ? code : "hostRecoveryFailed",
              ),
            );
          } else resolve(value);
        });
      },
    );
    request.setTimeout(15000, () => request.destroy(new RecoveryCommandError("hostRecoveryUnconfirmed")));
    request.on("error", () => reject(new RecoveryCommandError("hostRecoveryUnconfirmed")));
    request.end(bytes);
  });
}
export async function recoverDatabaseOperation(options: DatabaseRecoveryCommandOptions) {
  if (!isAbsolute(options.stateRoot) || !isAbsolute(options.output))
    throw new RecoveryCommandError("hostRecoveryArguments");
  const base = loopbackUrl(options.url),
    directory = join(options.stateRoot, "database-management");
  await privateDirectory(options.stateRoot, false);
  await privateDirectory(directory);
  const marker = await privateJson<DatabaseHostRecoveryMarker>(join(directory, "host-recovery.json"));
  if (!databaseIdentifier(marker.operationId) || !capability(marker.secret))
    throw new RecoveryCommandError("hostRecoveryPrivateFile");
  const maintenance = (await call(base, "/api/system/database/maintenance")) as {
    operationId?: unknown;
    status?: unknown;
  };
  if (maintenance?.operationId !== marker.operationId) throw new RecoveryCommandError("hostRecoveryOperationChanged");
  if (maintenance.status !== "failed") {
    const saved = options.retry ? await savedCapability(options.output) : null;
    if (saved?.operationId === marker.operationId) {
      const operation = (await call(base, "/api/system/database/operations/" + marker.operationId, undefined, {
        "X-Panda-Database-Operation": saved.statusToken,
      })) as { id?: string; status?: string };
      if (
        operation.id === marker.operationId &&
        ["waiting-restart", "running", "complete"].includes(operation.status ?? "")
      )
        return { operationId: marker.operationId, output: options.output, retried: true };
    }
    throw new RecoveryCommandError("migrationAlreadyRunning");
  }
  const saved = await saveCapability(options.output, marker.operationId);
  const rotated = (await call(
    base,
    "/api/system/database/host-recovery",
    { statusToken: saved.statusToken },
    { "X-Panda-Database-Host-Recovery": marker.secret },
  )) as { operationId?: unknown; recovered?: unknown };
  if (rotated?.operationId !== marker.operationId || rotated.recovered !== true)
    throw new RecoveryCommandError("hostRecoveryUnconfirmed");
  if (options.retry) {
    const result = (await call(
      base,
      "/api/system/database/operations/" + marker.operationId + "/retry",
      {},
      { "X-Panda-Database-Operation": saved.statusToken },
    )) as { id?: string; status?: string };
    if (result?.id !== marker.operationId || !["waiting-restart", "running", "complete"].includes(result.status ?? ""))
      throw new RecoveryCommandError("hostRecoveryUnconfirmed");
  }
  return { operationId: marker.operationId, output: options.output, retried: options.retry };
}
const errorMessages: Record<string, MessageId> = {
  hostRecoveryArguments: "database.hostRecoveryArguments",
  hostRecoveryPrivateFile: "database.hostRecoveryPrivateFile",
  hostRecoveryOperationChanged: "database.hostRecoveryOperationChanged",
  hostRecoveryUnconfirmed: "database.hostRecoveryUnconfirmed",
  administratorRequired: "database.administratorRequired",
  operationTokenInvalid: "database.operationTokenInvalid",
  operationNotFound: "database.operationNotFound",
  migrationAlreadyRunning: "database.migrationAlreadyRunning",
  invalidDatabaseConfiguration: "database.invalidDatabaseConfiguration",
  databaseUnavailable: "database.databaseUnavailable",
};
export async function runDatabaseRecoveryCommand(args: string[]) {
  const preferred = args[args.indexOf("--locale") + 1],
    locale = locales.includes(preferred ?? "") ? preferred : "en";
  const t = serverTranslator(locale);
  try {
    if (args.some((value) => ["--help", "-h"].includes(value))) {
      const remaining = args.filter((value) => !["--help", "-h"].includes(value));
      if (
        remaining.length &&
        !(remaining.length === 2 && remaining[0] === "--locale" && locales.includes(remaining[1]!))
      )
        throw new RecoveryCommandError("hostRecoveryArguments");
      console.log(t("database.hostRecoveryHelp"));
      return;
    }
    const values = new Map<string, string>();
    let retry = false;
    for (let index = 0; index < args.length; index++) {
      const key = args[index]!;
      if (key === "--retry" && !retry) {
        retry = true;
        continue;
      }
      if (!["--state-root", "--url", "--output", "--locale"].includes(key) || values.has(key))
        throw new RecoveryCommandError("hostRecoveryArguments");
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new RecoveryCommandError("hostRecoveryArguments");
      values.set(key, value);
    }
    if (
      !values.get("--state-root") ||
      !values.get("--url") ||
      !values.get("--output") ||
      (values.has("--locale") && !locales.includes(values.get("--locale")!))
    )
      throw new RecoveryCommandError("hostRecoveryArguments");
    const result = await recoverDatabaseOperation({
      stateRoot: values.get("--state-root")!,
      url: values.get("--url")!,
      output: values.get("--output")!,
      retry,
    });
    console.log(t("database.hostRecoverySaved", { path: result.output }));
    if (result.retried) console.log(t("database.hostRecoveryRetryQueued"));
  } catch (error) {
    const code = error instanceof RecoveryCommandError ? error.code : "hostRecoveryPrivateFile";
    console.error(t(errorMessages[code] ?? "database.hostRecoveryFailed"));
    process.exitCode = 1;
  }
}
if (import.meta.main) await runDatabaseRecoveryCommand(process.argv.slice(2));
