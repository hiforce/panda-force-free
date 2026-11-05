import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocket, type RawData } from "ws";
import { errorMessage } from "../../shared/errors.js";
import { nativeEnvelope } from "../protocol/native.js";
import { errorCode } from "./../../shared/errors.js";
import { SharedWebSocket, sendSharedMessage } from "./shared-websocket.js";

const REQUEST_TIMEOUT_MS = 30000;
const RESTART_DELAY_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 20000;
const READ_METHODS = new Set([
  "model/list",
  "permissionProfile/list",
  "account/read",
  "account/rateLimits/read",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/items/list",
  "thread/turns/list",
  "thread/queue/list",
  "thread/goal/get",
]);

function disconnectedError(closeCode: number | null) {
  if (closeCode === 1009)
    return Object.assign(new Error("Codex response exceeded the connection message limit; refresh the conversation"), {
      code: "codex_response_too_large",
    });
  return Object.assign(new Error("Codex app-server disconnected"), { code: "codex_disconnected" });
}

export type { CodexConnection } from "../engines/codex-transport.js";
import type { CodexTransport, CodexTransportOptions } from "../engines/codex-transport.js";

/**
 * Owns the Codex app-server transport: the spawned stdio child (isolated
 * mode) or the shared unix-socket WebSocket, JSON-RPC request/response
 * pairing with timeouts, the initialize handshake, and reconnect-on-exit.
 * Everything PandaForce-specific happens in the injected callbacks.
 */
export function createCodexBridge({
  connection,
  defaultCwd,
  clientInfo,
  isShuttingDown,
  onMessage,
  onConnected,
  onDisconnected,
}: CodexTransportOptions): CodexTransport {
  let seq = 1;
  let codex: ChildProcessWithoutNullStreams | null = null;
  let codexSocket: WebSocket | null = null;
  let stdoutBuffer = "";
  let connected = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  function start() {
    if (isShuttingDown()) return;
    if (codexSocket) return;
    if (codex && codex.exitCode === null) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    if (connection.mode === "shared") {
      const socket = new SharedWebSocket(`ws+unix://${connection.socketPath}:/`, {
        handshakeTimeout: 10000,
        maxPayload: 128 * 1024 * 1024,
      });
      codexSocket = socket;
      connected = false;
      let lastResponse = Date.now();
      socket.on("open", () => {
        heartbeat = setInterval(() => {
          if (socket !== codexSocket || socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastResponse > HEARTBEAT_INTERVAL_MS * 3) {
            console.warn("[panda-force] shared app-server heartbeat timed out; reconnecting");
            socket.terminate();
          } else socket.ping();
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref();
        initialize().catch((error) => {
          console.error("[panda-force] shared app-server initialize failed:", error.message);
          socket.terminate();
        });
      });
      socket.on("message", (raw: RawData) => {
        lastResponse = Date.now();
        try {
          handleMessage(JSON.parse(String(raw)));
        } catch (error) {
          console.error("[panda-force] invalid shared app-server message:", error);
        }
      });
      socket.on("pong", () => {
        lastResponse = Date.now();
      });
      socket.on("error", (error: Error) => console.error("[panda-force] shared app-server:", error.message));
      socket.on("close", (code: number, reason: Buffer) => {
        if (codexSocket !== socket) return;
        codexSocket = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (!isShuttingDown())
          console.warn(
            `[panda-force] shared app-server disconnected: code=${code}, reason=${String(reason).slice(0, 160) || "none"}, pending=${pending.size}`,
          );
        handleDisconnect(code, null);
      });
      return;
    }
    const child = spawn("codex", ["app-server", "--stdio"], {
      cwd: defaultCwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    codex = child;
    connected = false;
    stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const pos = stdoutBuffer.indexOf("\n");
        if (pos < 0) break;
        const line = stdoutBuffer.slice(0, pos).trim();
        stdoutBuffer = stdoutBuffer.slice(pos + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch (error) {
          console.error("[panda-force] invalid app-server JSON:", line, error);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => console.error("[codex app-server]", String(data).trimEnd()));
    child.on("exit", (code, signal) => {
      if (codex === child) codex = null;
      handleDisconnect(code, signal);
    });
    initialize().catch((error) => {
      console.error("[panda-force] initialize failed", error);
      terminate();
    });
  }

  function handleDisconnect(code: number | null, signal: string | null) {
    connected = false;
    for (const item of pending.values()) item.reject(disconnectedError(code));
    pending.clear();
    onDisconnected(code, signal);
    if (!isShuttingDown()) {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(start, RESTART_DELAY_MS);
    }
  }

  function terminate(signal: NodeJS.Signals = "SIGTERM") {
    // A shared daemon belongs to all clients, including SSH. Only detach PandaForce.
    if (codexSocket) {
      codexSocket.terminate();
      return;
    }
    const child = codex;
    if (!child || child.exitCode !== null) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        /* Fall back to terminating the wrapper process. */
      }
    }
    child.kill(signal);
  }

  function sendRaw(message: object) {
    if (isShuttingDown()) throw new Error("PandaForce is shutting down");
    start();
    if (codexSocket) {
      if (codexSocket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is connecting");
      sendSharedMessage(codexSocket, message);
      return;
    }
    codex!.stdin.write(JSON.stringify(message) + "\n");
  }

  function requestOnce(method: string, params: Record<string, unknown>, timeoutMs: number) {
    const id = seq++;
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        sendRaw({ id, method, params });
      } catch (error) {
        const item = pending.get(id);
        pending.delete(id);
        item?.reject(error as Error);
      }
    });
  }

  function waitUntilReady(timeoutMs: number) {
    if (connected) return Promise.resolve();
    if (isShuttingDown()) return Promise.reject(new Error("PandaForce is shutting down"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        readyWaiters.delete(waiter);
        reject(new Error("Codex app-server connection timed out"));
      }, timeoutMs);
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          readyWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          readyWaiters.delete(waiter);
          reject(error);
        },
      };
      readyWaiters.add(waiter);
      start();
    });
  }

  async function request(method: string, params: Record<string, unknown> = {}) {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const remaining = () => Math.max(1, deadline - Date.now());
    for (let attempt = 0; ; attempt++) {
      await waitUntilReady(remaining());
      try {
        return await requestOnce(method, params, remaining());
      } catch (error) {
        // Queries can recover once after a lost connection. An input may have
        // already reached Codex, so never replay a turn or another mutation.
        if (
          attempt ||
          connection.mode !== "shared" ||
          errorCode(error) !== "codex_disconnected" ||
          !READ_METHODS.has(method) ||
          (method === "account/read" && params.refreshToken) ||
          Date.now() >= deadline
        )
          throw error;
      }
    }
  }

  async function initialize() {
    const result = await requestOnce(
      "initialize",
      {
        clientInfo,
        capabilities: { experimentalApi: true },
      },
      REQUEST_TIMEOUT_MS,
    );
    sendRaw({ method: "initialized", params: {} });
    connected = true;
    for (const waiter of readyWaiters) waiter.resolve();
    onConnected(result);
  }

  function handleMessage(input: unknown) {
    const message = nativeEnvelope(input);
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const item = pending.get(Number(message.id));
      if (item) {
        pending.delete(Number(message.id));
        if (message.error) item.reject(new Error(errorMessage(message.error, JSON.stringify(message.error))));
        else item.resolve(message.result);
        return;
      }
    }
    onMessage(message);
  }

  return {
    start,
    terminate,
    sendRaw,
    request,
    get connected() {
      return connected;
    },
    /** True once neither a child process nor a shared socket remains. */
    fullyStopped: () => !codex && !codexSocket,
    cancelRestart() {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
    },
    rejectPending(error: Error) {
      for (const item of pending.values()) item.reject(error);
      pending.clear();
      for (const waiter of readyWaiters) waiter.reject(error);
    },
  };
}
