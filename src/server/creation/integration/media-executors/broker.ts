import { timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage } from "node:http";
import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isRecord } from "../../../../shared/records.js";
import { readJsonBody } from "../../../http/body.js";
import { respondJson } from "../../../http/respond.js";
import { CreationError } from "../../contracts.js";
import { creationPrompt } from "../../input-values.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../../validation.js";
import { mediaBinding, mediaChoice } from "../../media-executors/selection.js";
import {
  MediaExecutorError,
  mediaExecutorErrors,
  type CreationMediaExecutorPort,
  type MediaPoll,
} from "../../media-executors/contracts.js";

const routePrefix = "/v1/media/";
const maxRequest = 256 * 1024;
const maxJson = 2 * 1024 * 1024;
const maxOriginal = 32 * 1024 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/;
const providerId = /^[a-zA-Z0-9_-]{1,160}$/;
type Operation = keyof CreationMediaExecutorPort;

export async function readMediaBrokerToken(path: string) {
  const info = await lstat(path);
  if (!isAbsolute(path) || (await realpath(path)) !== path || !info.isFile() || info.mode & 0o027 || info.size > 80)
    throw new MediaExecutorError("unavailable");
  const token = (await readFile(path, "utf8")).trim();
  if (!tokenPattern.test(token)) throw new MediaExecutorError("unavailable");
  return token;
}

function checkSocketPath(path: string) {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100) throw new MediaExecutorError("unavailable");
}

function authorized(supplied: unknown, expected: string) {
  return (
    typeof supplied === "string" &&
    tokenPattern.test(supplied) &&
    timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))
  );
}

async function invoke(port: CreationMediaExecutorPort, operation: string, input: unknown, signal: AbortSignal) {
  if (operation === "cliCatalog") {
    creationRecord(input, []);
    return port.cliCatalog();
  }
  if (operation === "cliInstructions" || operation === "registerCli") {
    const row = creationRecord(input, ["id", "revision", ...(operation === "registerCli" ? ["fingerprint"] : [])]);
    const id = creationText(row.id, 64);
    const revision = creationInteger(row.revision);
    if (operation === "cliInstructions") return port.cliInstructions(id, revision);
    await port.registerCli(id, revision, creationDigest(row.fingerprint), signal);
    return null;
  }
  const row = creationRecord(input, ["owner", "input", "id", "revision", "choice", "binding", "prompt", "taskId"]);
  const owner = creationText(row.owner, 200);
  if (operation === "list") return port.list(owner);
  if (operation === "save") return port.save(owner, row.input);
  if (operation === "saveCredential") return port.saveCredential(owner, row.input);
  if (operation === "removeCredential") {
    await port.removeCredential(owner, creationUuid(row.id), creationInteger(row.revision));
    return null;
  }
  if (operation === "remove") {
    await port.remove(owner, creationUuid(row.id), creationInteger(row.revision));
    return null;
  }
  if (operation === "bind") {
    const choice = mediaChoice(row.choice);
    if (choice.source !== "executor") throw new MediaExecutorError("invalidInput");
    return port.bind(owner, choice);
  }
  if (operation !== "assertBound" && operation !== "submit" && operation !== "poll" && operation !== "cancel")
    throw new MediaExecutorError("invalidInput");
  const binding = mediaBinding(row.binding);
  if (binding.source !== "executor") throw new MediaExecutorError("invalidInput");
  if (operation === "assertBound") {
    await port.assertBound(owner, binding);
    return null;
  }
  if (operation === "submit")
    return port.submit(owner, binding, creationDigest(row.id), creationPrompt(row.prompt), signal);
  const taskId = creationText(row.taskId, 160);
  if (!providerId.test(taskId)) throw new MediaExecutorError("invalidInput");
  return operation === "cancel"
    ? port.cancel(owner, binding, taskId, signal)
    : port.poll(owner, binding, taskId, signal);
}

export async function serveMediaBroker(socketPath: string, token: string, port: CreationMediaExecutorPort) {
  checkSocketPath(socketPath);
  if (!tokenPattern.test(token)) throw new MediaExecutorError("unavailable");
  const server = createServer((req, res) => {
    if (!authorized(req.headers["x-panda-media-token"], token)) {
      respondJson(res, 403, { code: "authentication" }, { connection: "close" });
      return;
    }
    const url = req.url;
    if (req.method !== "POST" || !url?.startsWith(routePrefix)) {
      respondJson(res, 404, { code: "notFound" });
      return;
    }
    if (Number(req.headers["content-length"]) > maxRequest) {
      respondJson(res, 413, { code: "invalidInput" }, { connection: "close" });
      return;
    }
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) controller.abort(new MediaExecutorError("unavailable"));
    });
    void (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(130000)]);
        const result = await invoke(port, url.slice(routePrefix.length), await readJsonBody(req, maxRequest), signal);
        if (res.destroyed) return;
        if (result && "state" in result && result.state === "succeeded") {
          if (!result.bytes.length || result.bytes.length > maxOriginal) throw new MediaExecutorError("invalidResult");
          const invocation = result.invocationId;
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": result.bytes.length,
            "cache-control": "no-store",
            ...(typeof invocation === "string" && providerId.test(invocation)
              ? { "x-panda-media-invocation": invocation }
              : {}),
          });
          res.end(result.bytes);
        } else respondJson(res, 200, result);
      } catch (error) {
        if (!res.destroyed) {
          const code =
            error instanceof MediaExecutorError
              ? error.code
              : error instanceof CreationError && error.code === "invalidInput"
                ? "invalidInput"
                : "unavailable";
          respondJson(res, 422, { code });
        }
      }
    })();
  });
  server.requestTimeout = 15000;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o660);
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

async function reply(res: IncomingMessage, operation: Operation) {
  const raw = res.headers["content-type"] === "application/octet-stream";
  if (raw && (res.statusCode !== 200 || (operation !== "submit" && operation !== "poll")))
    throw new MediaExecutorError("invalidResult");
  const max = raw ? maxOriginal : maxJson;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of res) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > max) throw new MediaExecutorError("invalidResult");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks, length);
  if (raw) {
    if (!length || Number(res.headers["content-length"]) !== length) throw new MediaExecutorError("invalidResult");
    const invocation = res.headers["x-panda-media-invocation"];
    return {
      state: "succeeded",
      bytes,
      ...(typeof invocation === "string" && providerId.test(invocation) ? { invocationId: invocation } : {}),
    } satisfies MediaPoll;
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (res.statusCode !== 200) {
    const code = isRecord(value) && mediaExecutorErrors.find((entry) => entry === value.code);
    throw new MediaExecutorError(code || "unavailable");
  }
  return value;
}

export function mediaBrokerClient(socketPath: string, token: () => Promise<string>): CreationMediaExecutorPort {
  checkSocketPath(socketPath);
  async function call<T>(operation: Operation, fields: object, abort?: AbortSignal): Promise<T> {
    const body = JSON.stringify(fields);
    const secret = await token();
    if (!tokenPattern.test(secret)) throw new MediaExecutorError("unavailable");
    const limit = AbortSignal.timeout(
      operation === "submit" || operation === "poll" || operation === "cancel" ? 130000 : 20000,
    );
    const signal = abort ? AbortSignal.any([limit, abort]) : limit;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: routePrefix + operation,
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "x-panda-media-token": secret,
          },
        },
        (res) => {
          void reply(res, operation).then((value) => resolve(value as T), reject);
        },
      );
      req.on("error", () => reject(new MediaExecutorError(operation === "submit" ? "uncertain" : "unavailable")));
      req.end(body);
    });
  }
  return {
    cliCatalog: () => call("cliCatalog", {}),
    cliInstructions: (id, revision) => call("cliInstructions", { id, revision }),
    registerCli: (id, revision, fingerprint, signal) => call("registerCli", { id, revision, fingerprint }, signal),
    list: (owner) => call("list", { owner }),
    save: (owner, input) => call("save", { owner, input }),
    saveCredential: (owner, input) => call("saveCredential", { owner, input }),
    removeCredential: (owner, id, revision) => call("removeCredential", { owner, id, revision }),
    remove: (owner, id, revision) => call("remove", { owner, id, revision }),
    bind: (owner, choice) => call("bind", { owner, choice }),
    assertBound: (owner, binding) => call("assertBound", { owner, binding }),
    submit: (owner, binding, id, prompt, signal) => call("submit", { owner, binding, id, prompt }, signal),
    poll: (owner, binding, taskId, signal) => call("poll", { owner, binding, taskId }, signal),
    cancel: (owner, binding, taskId, signal) => call("cancel", { owner, binding, taskId }, signal),
  };
}
