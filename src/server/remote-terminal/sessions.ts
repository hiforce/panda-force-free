import { Client, type ClientChannel } from "ssh2";
import { WebSocket } from "ws";
import { normalizeTerminalResize } from "../terminal/protocol.js";
import { type RemoteRegistry, remoteId } from "./registry.js";
import { RemoteError } from "./errors.js";
import { sshHostFingerprint } from "./host-key.js";
import type { RemoteErrorCode, RemoteTerminalMessage } from "../../shared/workspace-tools/remote.js";

const status = (client: WebSocket, message: RemoteTerminalMessage) => {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
};
const maximumBuffered = 1024 * 1024;

export class RemoteTerminalSessions {
  private readonly active = new Map<WebSocket, { owner: string; id: string; stop(): void }>();
  constructor(private readonly registry: RemoteRegistry) {}

  async open(browser: WebSocket, owner: string, url: URL) {
    if (browser.readyState !== WebSocket.OPEN) return;
    let id: string;
    try {
      if (url.searchParams.getAll("id").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "id"))
        throw new RemoteError("invalidInput");
      id = remoteId(url.searchParams.get("id"));
    } catch {
      status(browser, { type: "error", code: "invalidInput" });
      browser.close(1008);
      return;
    }
    if (this.active.size >= 32 || [...this.active.values()].filter((session) => session.owner === owner).length >= 8) {
      status(browser, { type: "error", code: "limit" });
      browser.close(1008);
      return;
    }
    const ssh = new Client();
    let ended = false,
      mismatch = false,
      ready = false;
    let size = { cols: 100, rows: 24 };
    let stream: ClientChannel | undefined;
    const finish = (error?: RemoteErrorCode) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.active.delete(browser);
      if (error) status(browser, { type: "error", code: error });
      if (browser.readyState === WebSocket.OPEN) browser.close(error ? 1011 : 1000);
      ssh.destroy();
    };
    const timer = setTimeout(() => finish("connectionFailed"), 15000);
    this.active.set(browser, { owner, id, stop: () => finish() });
    browser.once("close", () => finish());
    browser.once("error", () => finish());
    browser.on("message", (raw, binary) => {
      if (!binary) {
        try {
          const resize = normalizeTerminalResize(JSON.parse(String(raw)));
          if (resize) {
            size = resize;
            stream?.setWindow(size.rows, size.cols, 0, 0);
          }
        } catch {
          /* The only accepted text frame is a resize. */
        }
        return;
      }
      if (!stream || !Buffer.isBuffer(raw) || raw.length > 65536) return;
      if (stream.writableLength > maximumBuffered) return finish("limit");
      stream.write(raw);
    });
    ssh.on("error", (error) =>
      finish(
        mismatch
          ? "hostKeyMismatch"
          : error.level === "client-authentication"
            ? "authenticationFailed"
            : "connectionFailed",
      ),
    );
    ssh.once("close", () => finish(ready ? undefined : "connectionFailed"));
    try {
      const { profile, secret } = await this.registry.connection(owner, id);
      if (ended) return;
      ssh.once("ready", () => {
        ssh.shell({ term: "xterm-256color", ...size }, (error, channel) => {
          if (error) return finish("connectionFailed");
          if (ended) {
            channel.close();
            return;
          }
          clearTimeout(timer);
          ready = true;
          stream = channel;
          stream.setWindow(size.rows, size.cols, 0, 0);
          const output = (data: Buffer) => {
            if (browser.readyState !== WebSocket.OPEN) return;
            if (browser.bufferedAmount > maximumBuffered) return finish("limit");
            browser.send(data, { binary: true });
          };
          stream.on("data", output);
          stream.stderr.on("data", output);
          stream.on("error", () => finish("connectionFailed"));
          stream.once("close", () => finish());
          status(browser, { type: "ready" });
        });
      });
      ssh.connect({
        host: profile.host,
        port: profile.port,
        username: profile.username,
        readyTimeout: 10000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        tryKeyboard: false,
        ...(profile.method === "password"
          ? { password: String(secret.password) }
          : { privateKey: String(secret.privateKey) }),
        hostVerifier: (key: Buffer) => {
          mismatch = sshHostFingerprint(key) !== profile.hostKey;
          return !mismatch;
        },
      });
    } catch (error) {
      finish(error instanceof RemoteError ? error.code : "unavailable");
    }
  }

  revoke(owner: string, id: string) {
    for (const session of this.active.values()) if (session.owner === owner && session.id === id) session.stop();
  }
  close() {
    for (const [browser, session] of this.active) {
      session.stop();
      browser.terminate();
    }
  }
}
