import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { isRecord } from "../../shared/records.js";
import { stableJson } from "../../shared/stable-json.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import type {
  ApplicationToolCall,
  ApplicationToolEngine,
  ApplicationToolResult,
} from "../../shared/engine/application-tools.js";

const CALLBACK_PATH = "/creation-callback";

interface CliDispatch {
  invoke(): Promise<ApplicationToolResult>;
  work?: Promise<ApplicationToolResult>;
}

/** All Creation runtimes use the same CLI dispatch after their adapter has authenticated a tool request. */
export function creationCliEngine(
  engine: ApplicationToolEngine,
  options: { command?: string; mode?: string } = {},
): ApplicationToolEngine {
  return {
    ...engine,
    async run(input, callbacks) {
      const mode = options.mode ?? process.env.PANDA_FORCE_CREATION_CALLBACK_MODE ?? "auto";
      if (mode === "protocol") return engine.run(input, callbacks);
      if (mode !== "auto" && mode !== "cli") throw new HarnessError("capabilityUnavailable", 409);
      const command = options.command ?? "/usr/local/bin/panda";
      try {
        await access(command, constants.X_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && mode === "auto") return engine.run(input, callbacks);
        throw new HarnessError("capabilityUnavailable", 409);
      }
      callbacks.signal.throwIfAborted();
      const cli = await openCreationCli(command, (call) => callbacks.call(call), callbacks.signal);
      try {
        return await engine.run(input, { ...callbacks, signal: cli.signal, call: cli.call });
      } finally {
        await cli.close();
      }
    },
  };
}

async function openCreationCli(
  command: string,
  invoke: (call: ApplicationToolCall) => Promise<ApplicationToolResult>,
  parentSignal: AbortSignal,
) {
  const shutdown = new AbortController(),
    signal = AbortSignal.any([parentSignal, shutdown.signal]),
    authorization = "Bearer " + randomBytes(32).toString("hex"),
    dispatches = new Map<string, CliDispatch>(),
    calls = new Map<string, { digest: string; result: Promise<ApplicationToolResult> }>();
  const server = createServer(async (req, res) => {
    const reply = (status: number, value?: Record<string, unknown>) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (
      signal.aborted ||
      req.headers.origin ||
      req.headers.authorization !== authorization ||
      req.url !== CALLBACK_PATH
    )
      return reply(403);
    if (req.method !== "POST") return reply(405);
    try {
      let input = "";
      for await (const chunk of req) {
        input += chunk.toString();
        if (input.length > 1024) return reply(413);
      }
      const frame: unknown = JSON.parse(input);
      if (!isRecord(frame) || typeof frame.requestId !== "string") return reply(400);
      const dispatch = dispatches.get(frame.requestId);
      if (!dispatch) return reply(404);
      signal.throwIfAborted();
      if (!dispatch.work) {
        dispatch.work = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return dispatch.invoke();
        });
        // The run consumes the result once the CLI confirms dispatch.
        void dispatch.work.catch(() => {});
      }
      reply(202, { requestId: frame.requestId, accepted: true });
    } catch {
      reply(400);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new HarnessError("unavailable");
  const endpoint = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  return {
    signal,
    async call(call: ApplicationToolCall) {
      signal.throwIfAborted();
      const key = call.callId,
        digest = createHash("sha256").update(stableJson(call)).digest("hex"),
        previous = calls.get(key);
      if (previous) {
        if (previous.digest !== digest) throw new HarnessError("conflict", 409);
        return previous.result;
      }
      if (calls.size >= 128) throw new HarnessError("capabilityUnavailable", 409);
      const snapshot = structuredClone(call),
        requestId = randomUUID(),
        dispatch: CliDispatch = { invoke: () => invoke(snapshot) };
      dispatches.set(requestId, dispatch);
      const result = (async () => {
        try {
          await dispatchCreationCli(command, { endpoint, authorization, requestId }, signal);
          signal.throwIfAborted();
          if (!dispatch.work) throw new HarnessError("invalidProtocol", 503);
          return await dispatch.work;
        } finally {
          dispatches.delete(requestId);
        }
      })();
      calls.set(key, { digest, result });
      return result;
    },
    async close() {
      shutdown.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function dispatchCreationCli(
  command: string,
  request: { endpoint: string; authorization: string; requestId: string },
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      command,
      ["creation", "callback", "--stdin", "--json"],
      { cwd: "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, timeout: 15000, signal, maxBuffer: 4096 },
      (error, stdout) => {
        if (error) return reject(new HarnessError("capabilityUnavailable", 409));
        try {
          const reply: unknown = JSON.parse(stdout);
          if (!isRecord(reply) || reply.requestId !== request.requestId || reply.accepted !== true)
            throw new HarnessError("invalidProtocol", 503);
          resolve();
        } catch {
          reject(new HarnessError("invalidProtocol", 503));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}
