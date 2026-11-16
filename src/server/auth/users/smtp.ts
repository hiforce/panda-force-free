import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { AccountError } from "./contracts.js";

export interface SmtpConnection {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  password: string;
  ca?: string;
}
interface Reply {
  code: number;
  lines: string[];
}

/** Bounded SMTP replies, one command at a time, with no credentials or server reply text in errors. */
class SmtpWire {
  private buffer = "";
  private lines: string[] = [];
  private bytes = 0;
  private replies: Reply[] = [];
  private pending: { resolve(reply: Reply): void; reject(error: Error): void } | null = null;
  private failed = false;
  constructor(readonly socket: Socket | TLSSocket) {
    socket.on("data", this.data);
    socket.on("error", this.fail);
    socket.on("close", this.fail);
  }
  private data = (chunk: Buffer) => {
    this.bytes += chunk.length;
    if (this.bytes > 65536) return this.fail();
    this.buffer += chunk.toString("utf8");
    while (this.buffer.includes("\r\n")) {
      const end = this.buffer.indexOf("\r\n"),
        line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (
        !/^\d{3}[ -]/.test(line) ||
        line.length > 4096 ||
        this.lines.length >= 100 ||
        (this.lines.length && this.lines[0].slice(0, 3) !== line.slice(0, 3))
      )
        return this.fail();
      this.lines.push(line);
      if (line[3] !== " ") continue;
      const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
      this.lines = [];
      this.bytes = 0;
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        pending.resolve(reply);
      } else {
        this.replies.push(reply);
        if (this.replies.length > 2) return this.fail();
      }
    }
  };
  private fail = () => {
    this.failed = true;
    this.pending?.reject(new AccountError("mailUnavailable", 503));
    this.pending = null;
    this.socket.destroy();
  };
  read(): Promise<Reply> {
    if (this.failed || this.pending) return Promise.reject(new AccountError("mailUnavailable", 503));
    const queued = this.replies.shift();
    return queued
      ? Promise.resolve(queued)
      : new Promise((resolve, reject) => {
          this.pending = { resolve, reject };
        });
  }
  async command(command: string, expected: readonly number[]) {
    if (/[\r\n]/.test(command)) throw new AccountError("invalidInput");
    const reply = this.read();
    this.socket.write(command + "\r\n");
    const result = await reply;
    if (!expected.includes(result.code)) throw new AccountError("mailUnavailable", 503);
    return result;
  }
  detach() {
    if (this.buffer || this.lines.length || this.replies.length || this.pending)
      throw new AccountError("mailUnavailable", 503);
    this.socket.off("data", this.data);
    this.socket.off("error", this.fail);
    this.socket.off("close", this.fail);
  }
}

async function ready(socket: Socket | TLSSocket, event: "connect" | "secureConnect") {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      socket.off("error", fail);
      socket.off("close", fail);
      resolve();
    };
    const fail = () => {
      socket.off(event, done);
      socket.off("error", fail);
      socket.off("close", fail);
      reject(new AccountError("mailUnavailable", 503));
    };
    socket.once(event, done);
    socket.once("error", fail);
    socket.once("close", fail);
  });
}

/** TLS is mandatory, including before AUTH. Administrator-supplied CA certificates remain verified. */
export async function smtpSession(
  config: SmtpConnection,
  signal: AbortSignal,
  message?: { from: string; to: string; source: string },
) {
  signal.throwIfAborted();
  let socket: Socket | TLSSocket;
  const tls = {
    host: config.host,
    port: config.port,
    ...(isIP(config.host) ? {} : { servername: config.host }),
    rejectUnauthorized: true,
    minVersion: "TLSv1.2" as const,
    ...(config.ca ? { ca: config.ca } : {}),
  };
  socket = config.security === "tls" ? connectTls(tls) : connectTcp({ host: config.host, port: config.port });
  const abort = () => socket.destroy(new AccountError("mailUnavailable", 503));
  const deadline = setTimeout(abort, 25_000);
  deadline.unref();
  signal.addEventListener("abort", abort, { once: true });
  let wire = new SmtpWire(socket);
  try {
    await ready(socket, config.security === "tls" ? "secureConnect" : "connect");
    if ((await wire.read()).code !== 220) throw new AccountError("mailUnavailable", 503);
    let hello = await wire.command("EHLO panda-force", [250]);
    if (config.security === "starttls") {
      if (!hello.lines.some((line) => /^250[ -]STARTTLS\b/i.test(line))) throw new AccountError("mailUnavailable", 503);
      await wire.command("STARTTLS", [220]);
      wire.detach();
      socket = connectTls({ ...tls, socket });
      wire = new SmtpWire(socket);
      await ready(socket, "secureConnect");
      hello = await wire.command("EHLO panda-force", [250]);
    }
    if (config.username) {
      const methods = hello.lines
        .filter((line) => /^250[ -]AUTH[ =]/i.test(line))
        .join(" ")
        .toUpperCase();
      if (/\bPLAIN\b/.test(methods))
        await wire.command(
          "AUTH PLAIN " + Buffer.from(`\0${config.username}\0${config.password}`).toString("base64"),
          [235],
        );
      else if (/\bLOGIN\b/.test(methods)) {
        await wire.command("AUTH LOGIN", [334]);
        await wire.command(Buffer.from(config.username).toString("base64"), [334]);
        await wire.command(Buffer.from(config.password).toString("base64"), [235]);
      } else throw new AccountError("mailUnavailable", 503);
    }
    if (message) {
      if (
        !/^[^\s<>@]+@[^\s<>@]+$/.test(message.from) ||
        !/^[^\s<>@]+@[^\s<>@]+$/.test(message.to) ||
        Buffer.byteLength(message.source) > 262144
      )
        throw new AccountError("invalidInput");
      await wire.command(`MAIL FROM:<${message.from}>`, [250]);
      await wire.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await wire.command("DATA", [354]);
      const reply = wire.read();
      socket.write(message.source.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..") + "\r\n.\r\n");
      if ((await reply).code !== 250) throw new AccountError("mailUnavailable", 503);
    }
    // A successful DATA acknowledgement is authoritative even if QUIT or the final close is lost.
    try {
      await wire.command("QUIT", [221]);
    } catch {
      if (!message) throw new AccountError("mailUnavailable", 503);
    }
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError("mailUnavailable", 503);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    socket.destroy();
  }
}
