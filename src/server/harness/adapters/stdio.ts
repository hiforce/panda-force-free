import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { HarnessError, type HarnessErrorCode } from "../../../shared/harness/contracts.js";
import { isRecord } from "../../../shared/records.js";

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
export interface HarnessStdioOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  protocol?: "jsonrpc" | "zcode";
  onNotification?(method: string, params: Record<string, unknown>): Promise<void> | void;
  onRequest?(method: string, params: Record<string, unknown>): Promise<unknown>;
  onDisconnect?(error: HarnessTransportError): void;
}
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
  constructor(private readonly options: HarnessStdioOptions) {}
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.stopped) return Promise.reject(new HarnessTransportError("unavailable", false));
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: this.options.env,
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
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.fail(new HarnessTransportError("invalidProtocol", true));
        return;
      }
      if (!line.trim()) continue;
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
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
          const bytes = Buffer.byteLength(line);
          this.notificationBytes += bytes;
          if (this.notificationBytes > MAX_FRAME_BYTES) {
            this.fail(new HarnessTransportError("invalidProtocol", true));
            return;
          }
          if (this.notificationBytes > MAX_FRAME_BYTES / 4) this.child?.stdout.pause();
          this.notifications = this.notifications
            .then(async () => {
              if (!this.stopped) await this.options.onNotification?.(frame.method as string, params);
            })
            .catch(() => {
              this.notificationFailure = new HarnessTransportError("unavailable", true);
              this.fail(this.notificationFailure);
            })
            .finally(() => {
              this.notificationBytes -= bytes;
              if (this.notificationBytes < MAX_FRAME_BYTES / 8) this.child?.stdout.resume();
            });
        }
      } else if (typeof frame.id === "number") {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
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
    if (!this.child || this.failure || this.stopped)
      throw this.failure ?? new HarnessTransportError("unavailable", false);
    const bytes = JSON.stringify(this.options.protocol === "zcode" ? frame : { jsonrpc: "2.0", ...frame }) + "\n";
    if (Buffer.byteLength(bytes) > MAX_FRAME_BYTES) throw new HarnessTransportError("invalidInput", false);
    this.child.stdin.write(bytes);
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
