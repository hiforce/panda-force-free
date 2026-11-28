import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../../../../shared/records.js";
import type { ApiMediaPreset } from "./presets.js";
import type { MediaConnection, MediaProvider } from "../../media-executors/contracts.js";
import { MediaExecutorError } from "../../media-executors/contracts.js";
import { creationInteger, creationRecord, creationText } from "../../validation.js";

const requiredOperations = ["version", "check", "submit", "status", "result", "download"] as const;
const registeredOperations = [...requiredOperations, "cancel"] as const;
type Operation = (typeof registeredOperations)[number];
const maximumResult = 32 * 1024 * 1024;
const providerId = /^[a-z][a-z0-9-]{0,59}$/;
const externalId = /^[a-z\d][a-z\d_-]{0,159}$/i;
const stringHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

interface InstalledCli {
  executable: string;
  digest: string;
  version: string;
  operations: Record<(typeof requiredOperations)[number], string[]> & { cancel?: string[] };
}

function packageFile(path: string, maximum: number) {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && realpathSync(path) === path && (stat.mode & 0o022) === 0 && stat.size && stat.size <= maximum)
      return stat;
  } catch {
    throw new MediaExecutorError("invalidInput");
  }
  throw new MediaExecutorError("invalidInput");
}

function id(value: unknown) {
  if (typeof value !== "string" || !externalId.test(value)) throw new MediaExecutorError("invalidResult");
  return value;
}

function binary(cli: InstalledCli) {
  try {
    const stat = packageFile(cli.executable, 200 * 1024 * 1024);
    if (!(stat.mode & 0o111) || stringHash(cli.executable) !== cli.digest) throw Error();
  } catch {
    throw new MediaExecutorError("unavailable");
  }
}

function invoke(
  cli: InstalledCli,
  operation: Operation,
  connection: MediaConnection,
  input: object,
  cwd: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = execFile(
      cli.executable,
      cli.operations[operation]!,
      {
        cwd,
        shell: false,
        signal,
        timeout: 45000,
        maxBuffer: 262144,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
          PANDA_MEDIA_BASE_URL: connection.baseUrl,
          PANDA_MEDIA_API_KEY: connection.apiKey,
          PANDA_MEDIA_PROTOCOL: "panda.media-cli/v1",
        },
      },
      (error, stdout) => {
        if (error) return reject(new MediaExecutorError(operation === "submit" ? "uncertain" : "unavailable"));
        try {
          const value: unknown = JSON.parse(stdout);
          if (!isRecord(value)) throw Error();
          if (value.error === "authentication" || value.error === "rateLimited" || value.error === "failed")
            return reject(new MediaExecutorError(value.error));
          resolve(value);
        } catch {
          reject(new MediaExecutorError(operation === "submit" ? "uncertain" : "invalidResult"));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input) + "\n");
  });
}

function cliMediaProvider(
  cli: InstalledCli,
  kind: ApiMediaPreset["kind"],
): MediaProvider & {
  verify(signal: AbortSignal): Promise<void>;
  verifyInstallation(signal: AbortSignal): Promise<void>;
} {
  async function isolated<T>(work: (cwd: string) => Promise<T>) {
    binary(cli);
    const cwd = await mkdtemp(join(tmpdir(), "panda-creation-media-cli-"));
    try {
      return await work(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
  let versionCheck: Promise<void> | undefined;
  const verifyInstallation = (signal: AbortSignal) =>
    isolated(async (cwd) => {
      const version = await invoke(cli, "version", { apiKey: "", baseUrl: "" }, {}, cwd, signal);
      if (version.protocol !== "panda.media-cli/v1" || version.version !== cli.version)
        throw new MediaExecutorError("unavailable");
    });
  const verify = (signal: AbortSignal) =>
    (versionCheck ??= verifyInstallation(signal).catch((error) => {
      versionCheck = undefined;
      throw error;
    }));
  return {
    verify,
    verifyInstallation,
    ...(cli.operations.cancel
      ? {
          cancel: (connection, task, signal) =>
            isolated(async (cwd) => {
              const taskId = id(task);
              const reply = await invoke(cli, "cancel", connection, { taskId }, cwd, signal);
              if (reply.taskId !== taskId || (reply.state !== "cancelled" && reply.state !== "notCancellable"))
                throw new MediaExecutorError("invalidResult");
              return { state: reply.state === "cancelled" ? "cancelled" : "stoppedLocally" };
            }),
        }
      : {}),
    async check(connection, signal) {
      await verify(signal);
      return isolated(async (cwd) => {
        const info = await invoke(cli, "check", connection, {}, cwd, signal);
        if (
          info.connected !== true ||
          !Array.isArray(info.capabilities) ||
          !info.capabilities.includes(kind + ".generate")
        )
          throw new MediaExecutorError("authentication");
        return "connected" as const;
      });
    },
    submit: (connection, request, signal) =>
      isolated(async (cwd) => {
        const submitted = await invoke(cli, "submit", connection, request, cwd, signal);
        let taskId: string;
        try {
          taskId = id(submitted.taskId);
        } catch {
          throw new MediaExecutorError("uncertain");
        }
        return { state: "pending", taskId };
      }),
    poll: (connection, task, signal) =>
      isolated(async (cwd) => {
        const taskId = id(task);
        const status = await invoke(cli, "status", connection, { taskId }, cwd, signal);
        if (status.taskId !== taskId) throw new MediaExecutorError("invalidResult");
        if (status.state === "queued" || status.state === "running") return { state: "pending", taskId };
        if (status.state === "failed" || status.state === "cancelled") return { state: "failed" };
        if (status.state !== "succeeded") throw new MediaExecutorError("invalidResult");
        const output = await invoke(cli, "result", connection, { taskId }, cwd, signal);
        if (output.taskId !== taskId || !Array.isArray(output.outputs) || output.outputs.length !== 1)
          throw new MediaExecutorError("invalidResult");
        const result = output.outputs[0];
        if (
          !isRecord(result) ||
          typeof result.mime !== "string" ||
          (kind === "video"
            ? result.mime !== "video/mp4"
            : !["image/png", "image/jpeg", "image/webp"].includes(result.mime))
        )
          throw new MediaExecutorError("invalidResult");
        const outputId = id(result.id),
          outputFile = "result.media";
        const receipt = await invoke(cli, "download", connection, { taskId, outputId, outputFile }, cwd, signal);
        if (receipt.taskId !== taskId || receipt.outputId !== outputId || receipt.downloaded !== true)
          throw new MediaExecutorError("invalidResult");
        const file = await open(
          join(cwd, outputFile),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || !stat.size || stat.size > maximumResult)
            throw new MediaExecutorError("invalidResult");
          const bytes = Buffer.alloc(stat.size + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (
            bytesRead !== stat.size ||
            (result.sha256 !== undefined &&
              createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex") !== result.sha256)
          )
            throw new MediaExecutorError("invalidResult");
          return { state: "succeeded", bytes: bytes.subarray(0, bytesRead), invocationId: taskId };
        } finally {
          await file.close();
        }
      }),
  };
}

/** The deployment registers reviewed manifest paths. Model and browser input cannot install executables. */
export function installedMediaCli(path: string, requireInstalled = true) {
  if (!isAbsolute(path) || basename(path) !== "executor.json") throw new MediaExecutorError("invalidInput");
  packageFile(path, 32768);
  const manifest = readFileSync(path, "utf8");
  const row = creationRecord(JSON.parse(manifest), [
    "schema",
    "id",
    "revision",
    "version",
    "name",
    "model",
    "mode",
    "capabilities",
    "entrypoint",
    "connection",
    "usage",
    "install",
    "operations",
  ]);
  const operations = creationRecord(row.operations, registeredOperations);
  const connection = creationRecord(row.connection, ["baseUrl", "auth"]),
    base = creationRecord(connection.baseUrl, ["mode", "default"]),
    install = creationRecord(row.install, ["mode", "guide", "artifacts"]);
  const id = creationText(row.id, 60),
    version = creationText(row.version, 64),
    entrypoint = creationText(row.entrypoint, 240),
    baseUrl = creationText(base.default, 2048);
  const capability = Array.isArray(row.capabilities) && row.capabilities.length === 1 ? row.capabilities[0] : null;
  if (
    row.schema !== "panda.media-cli/v1" ||
    !providerId.test(id) ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ||
    row.mode !== "async" ||
    (capability !== "image.generate" && capability !== "video.generate") ||
    !/^bin\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entrypoint) ||
    connection.auth !== "api-key" ||
    (base.mode !== "provided" && base.mode !== "fixed") ||
    row.usage !== "USAGE.md" ||
    install.guide !== "INSTALL.md" ||
    (install.mode !== "preinstalled" && install.mode !== "pinned-artifact") ||
    !Array.isArray(install.artifacts) ||
    !install.artifacts.length ||
    install.artifacts.length > 8
  )
    throw new MediaExecutorError("invalidInput");
  const root = dirname(path);
  const documentation = (document: string) => {
    const filename = join(root, document);
    packageFile(filename, 65536);
    const content = readFileSync(filename, "utf8");
    if (!content.trim()) throw new MediaExecutorError("invalidInput");
    return content;
  };
  const instructions = { usage: documentation(row.usage), install: documentation(install.guide) };
  const installed = install.artifacts.map((value) => {
    const artifact = creationRecord(value, ["os", "arch", "file", "sha256"]);
    const digest = creationText(artifact.sha256, 64);
    if (
      (artifact.os !== "linux" && artifact.os !== "darwin") ||
      (artifact.arch !== "amd64" && artifact.arch !== "arm64") ||
      artifact.file !== entrypoint ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new MediaExecutorError("invalidInput");
    return { platform: artifact.os + ":" + artifact.arch, digest };
  });
  if (new Set(installed.map((item) => item.platform)).size !== installed.length)
    throw new MediaExecutorError("invalidInput");
  const artifact = installed.find(
    (item) => item.platform === process.platform + ":" + (process.arch === "x64" ? "amd64" : process.arch),
  );
  if (!artifact) throw new MediaExecutorError("unavailable");
  const { digest } = artifact,
    executable = join(root, entrypoint),
    kind = capability === "image.generate" ? "image" : "video";
  const argv = {} as InstalledCli["operations"];
  for (const name of registeredOperations) {
    const args = operations[name];
    if (name === "cancel" && args === undefined) continue;
    if (!Array.isArray(args) || args.length > 16) throw new MediaExecutorError("invalidInput");
    argv[name] = args.map((arg) => creationText(arg, 128));
  }
  const cli = { executable, version, digest, operations: argv };
  if (requireInstalled) binary(cli);
  const model = creationText(row.model, 128);
  const preset: ApiMediaPreset & { kind: "image" | "video" } = {
    id: "cli-" + id,
    transport: "cli",
    version: creationInteger(row.revision),
    name: creationText(row.name, 80),
    kind,
    models: [{ id: model, name: model }],
    baseUrl,
    ...(base.mode === "fixed" ? { fixedEndpoint: true } : {}),
    downloadHosts: [],
  };
  if (!preset.version) throw new MediaExecutorError("invalidInput");
  return {
    preset,
    version,
    sha256: digest,
    fingerprint: createHash("sha256").update(JSON.stringify({ manifest, instructions, digest })).digest("hex"),
    instructions,
    provider: cliMediaProvider(cli, kind),
  };
}
