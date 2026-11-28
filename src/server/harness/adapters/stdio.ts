import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { WebSocket } from "ws";
import { HarnessError, type HarnessErrorCode } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";
import { SharedWebSocket } from "../../bridge/shared-websocket.js";
import {
  nativeProcessLaunchSocket,
  openNativeProcessSocket,
  type NativeProcessPlan,
} from "../../engines/native-process.js";

export class HarnessTransportError extends HarnessError {
  constructor(
    code: HarnessErrorCode,
    readonly dispatched: boolean,
    readonly method?: string,
    readonly nativeCode?: number,
  ) {
    super(code, 503);
  }
}
interface TransportEvents {
  protocol?: "jsonrpc" | "zcode";
  onNotification?(method: string, params: Record<string, unknown>): Promise<void> | void;
  onRequest?(method: string, params: Record<string, unknown>): Promise<unknown>;
  onDisconnect?(error: HarnessTransportError): void;
}
export type HarnessStdioOptions = NativeProcessPlan & TransportEvents;
export interface HarnessRemoteAcpConnection {
  cwd: string;
  remoteWorkspace: string;
  remoteEndpoint: URL;
  apiKey: string;
  certificateAuthority?: string;
}
export type HarnessNativeConnection = NativeProcessPlan | { socketPath: string; cwd: string };
interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
  dispatched: boolean;
}
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Bounded bidirectional JSON-RPC; inbound request IDs never collide with outbound response pairing. */
export class HarnessStdioTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private socket: Socket | null = null;
  private remote: WebSocket | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private notifications: Promise<void> = Promise.resolve();
  private notificationBytes = 0;
  private notificationFailure: HarnessTransportError | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private failure: HarnessTransportError | null = null;
  constructor(private readonly options: (HarnessNativeConnection | HarnessRemoteAcpConnection) & TransportEvents) {}
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.stopped) return Promise.reject(new HarnessTransportError("unavailable", false));
    if ("remoteEndpoint" in this.options) return (this.starting = this.startRemote(this.options));
    if ("socketPath" in this.options) return (this.starting = this.startSocket(this.options.socketPath));
    let relay: string | undefined;
    try {
      relay = nativeProcessLaunchSocket();
    } catch {
      return Promise.reject(new HarnessTransportError("unavailable", false));
    }
    if (relay) return (this.starting = this.startSocket(relay, this.options));
    const { command, args, cwd, env } = this.options;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      });
      this.child = child;
      child.once("spawn", resolve);
      child.once("error", () => {
        const e = new HarnessTransportError("unavailable", false);
        reject(e);
        this.fail(e);
      });
      child.once("exit", () => this.fail(new HarnessTransportError("deliveryUncertain", true)));
      child.stdout.on("data", (data: Buffer) => this.receive(this.decoder.write(data)));
      // Drain stderr without putting native diagnostics or credentials on the protocol/UI channel.
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => this.fail(new HarnessTransportError("deliveryUncertain", true)));
    });
    return this.starting;
  }
  private startRemote({ remoteEndpoint, apiKey, certificateAuthority }: HarnessRemoteAcpConnection) {
    return new Promise<void>((resolve, reject) => {
      if (
        remoteEndpoint.protocol !== "wss:" ||
        remoteEndpoint.username ||
        remoteEndpoint.password ||
        remoteEndpoint.search ||
        remoteEndpoint.hash ||
        !/^[\x21-\x7e]{1,4096}$/.test(apiKey)
      )
        return reject(new HarnessTransportError("invalidInput", false));
      let socket: WebSocket;
      try {
        socket = new SharedWebSocket(remoteEndpoint, {
          headers: { Authorization: "Bearer " + apiKey },
          followRedirects: false,
          handshakeTimeout: 10000,
          maxPayload: MAX_FRAME_BYTES,
          perMessageDeflate: false,
          rejectUnauthorized: true,
          ...(certificateAuthority ? { ca: certificateAuthority } : {}),
        });
      } catch {
        return reject(new HarnessTransportError("unavailable", false));
      }
      this.remote = socket;
      let opened = false;
      const disconnect = (code: HarnessErrorCode) => {
        const failure = new HarnessTransportError(code, opened);
        reject(failure);
        this.fail(failure);
      };
      socket.once("open", () => {
        opened = true;
        resolve();
      });
      socket.once("unexpected-response", (request, response) => {
        disconnect(response.statusCode === 401 || response.statusCode === 403 ? "authentication" : "unavailable");
        response.destroy();
        request.destroy();
      });
      socket.on("error", () => disconnect(opened ? "deliveryUncertain" : "unavailable"));
      socket.once("close", () => disconnect(opened ? "deliveryUncertain" : "unavailable"));
      socket.on("message", (data, binary) => {
        if (binary) return;
        if (!Buffer.isBuffer(data)) return disconnect("invalidProtocol");
        this.receiveMessage(data.toString("utf8"));
      });
    });
  }
  private startSocket(path: string, launch?: NativeProcessPlan) {
    return new Promise<void>((resolve, reject) => {
      const consume = (data: Buffer) => this.receive(this.decoder.write(data));
      const socket = launch ? openNativeProcessSocket(path, launch, resolve, consume) : connect(path);
      this.socket = socket;
      const unavailable = new HarnessTransportError("unavailable", false);
      if (!launch) {
        socket.once("connect", resolve);
        socket.on("data", consume);
      }
      socket.on("error", () => {
        reject(unavailable);
        this.fail(new HarnessTransportError("deliveryUncertain", true));
      });
      socket.once("close", () => {
        reject(unavailable);
        this.fail(new HarnessTransportError("deliveryUncertain", true));
      });
    });
  }
  private receive(chunk: string) {
    if (this.failure || this.stopped) return;
    this.buffer += chunk;
    while (true) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) {
        if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES)
          this.fail(new HarnessTransportError("invalidProtocol", true));
        return;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) this.receiveMessage(line);
      if (this.failure) return;
    }
  }
  private receiveMessage(message: string) {
    if (this.failure || this.stopped) return;
    const size = Buffer.byteLength(message);
    let frame: Record<string, unknown>;
    try {
      if (size > MAX_FRAME_BYTES) throw Error();
      const parsed: unknown = JSON.parse(message);
      if (
        !isRecord(parsed) ||
        (this.options.protocol === "zcode" ? parsed.jsonrpc !== undefined : parsed.jsonrpc !== "2.0")
      )
        throw Error();
      frame = parsed;
    } catch {
      this.fail(new HarnessTransportError("invalidProtocol", true));
      return;
    }
    if (typeof frame.method === "string") {
      const params = isRecord(frame.params) ? frame.params : {};
      if (frame.id !== undefined) {
        if (typeof frame.id !== "string" && typeof frame.id !== "number") {
          this.fail(new HarnessTransportError("invalidProtocol", true));
          return;
        }
        const { id, method } = frame;
        void this.notifications.then(() => this.reply(id, method, params));
      } else {
        this.notificationBytes += size;
        if (this.notificationBytes > MAX_FRAME_BYTES) {
          this.fail(new HarnessTransportError("invalidProtocol", true));
          return;
        }
        if (this.notificationBytes > MAX_FRAME_BYTES / 4) (this.remote ?? this.socket ?? this.child?.stdout)?.pause();
        this.notifications = this.notifications
          .then(async () => {
            if (!this.stopped) await this.options.onNotification?.(frame.method as string, params);
          })
          .catch(() => {
            this.notificationFailure = new HarnessTransportError("unavailable", true);
            this.fail(this.notificationFailure);
          })
          .finally(() => {
            this.notificationBytes -= size;
            if (this.notificationBytes < MAX_FRAME_BYTES / 8)
              (this.remote ?? this.socket ?? this.child?.stdout)?.resume();
          });
      }
    } else if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);
      void this.notifications.then(() => {
        if (this.notificationFailure) pending.reject(this.notificationFailure);
        else if (frame.error !== undefined)
          pending.reject(this.remoteError(frame.error, pending.dispatched, pending.method));
        else pending.resolve(frame.result ?? {});
      });
    }
  }
  private remoteError(value: unknown, dispatched: boolean, method: string) {
    const code = isRecord(value) ? value.code : undefined;
    return new HarnessTransportError(
      code === -32000
        ? "authentication"
        : code === -32601
          ? "capabilityUnavailable"
          : code === -32002
            ? "notFound"
            : code === -32602
              ? "invalidProtocol"
              : "unavailable",
      dispatched,
      method,
      typeof code === "number" ? code : undefined,
    );
  }
  private async reply(id: string | number, method: string, params: Record<string, unknown>) {
    if (this.stopped || this.failure) return;
    try {
      if (!this.options.onRequest) throw new HarnessError("capabilityUnavailable");
      const result = await this.options.onRequest(method, params);
      this.write({ id, result: result ?? null });
    } catch (error) {
      if (!this.stopped && !this.failure)
        this.write({
          id,
          error: {
            code: error instanceof HarnessError && error.code === "capabilityUnavailable" ? -32601 : -32603,
            message: "Client request unavailable",
          },
        });
    }
  }
  private write(frame: object) {
    const writer = this.remote ?? this.socket ?? this.child?.stdin;
    if (!writer || this.failure || this.stopped) throw this.failure ?? new HarnessTransportError("unavailable", false);
    const bytes =
      JSON.stringify(this.options.protocol === "zcode" ? frame : { jsonrpc: "2.0", ...frame }) +
      (this.remote ? "" : "\n");
    if (Buffer.byteLength(bytes) > MAX_FRAME_BYTES) throw new HarnessTransportError("invalidInput", false);
    if (this.remote) {
      this.remote.send(bytes, (error) => {
        if (error) this.fail(new HarnessTransportError("deliveryUncertain", true));
      });
      return;
    }
    (this.socket ?? this.child?.stdin)!.write(bytes);
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeout: number | null = 30000,
  ): Promise<unknown> {
    await this.start();
    if (this.failure || this.stopped) throw this.failure ?? new HarnessTransportError("unavailable", false);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const item: Pending = {
        method,
        resolve,
        reject,
        dispatched: false,
        timer: null,
      };
      if (timeout !== null)
        item.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new HarnessTransportError("timeout", item.dispatched));
        }, timeout);
      this.pending.set(id, item);
      try {
        this.write({ id, method, params });
        item.dispatched = true;
      } catch (error) {
        this.pending.delete(id);
        if (item.timer) clearTimeout(item.timer);
        reject(error);
      }
    });
  }
  async notify(method: string, params: Record<string, unknown>) {
    await this.start();
    this.write({ method, params });
  }
  private fail(error: HarnessTransportError) {
    if (this.failure || this.stopped) return;
    this.failure = error;
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(new HarnessTransportError(error.code, item.dispatched));
    }
    this.pending.clear();
    this.remote?.terminate();
    this.socket?.destroy();
    this.options.onDisconnect?.(error);
    if (this.child?.pid) {
      try {
        if (process.platform === "win32") this.child.kill();
        else process.kill(-this.child.pid, "SIGTERM");
      } catch {}
    }
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(new HarnessTransportError("deliveryUncertain", item.dispatched));
    }
    this.pending.clear();
    this.remote?.terminate();
    this.remote = null;
    this.socket?.destroy();
    this.socket = null;
    const child = this.child;
    if (child && child.exitCode === null) {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.pid) {
            try {
              if (process.platform === "win32") child.kill("SIGKILL");
              else process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.notifications;
    this.child = null;
  }
}
