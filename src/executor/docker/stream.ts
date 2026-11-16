import { request } from "node:http";
import { BuildError } from "../../shared/builds/validation.js";
import { utf8Prefix } from "../../shared/utf8.js";

/** Docker's non-TTY stream has eight-byte headers; stderr never enters the artifact protocol. */
export class DockerStreams {
  private pending = Buffer.alloc(0);
  private output: Buffer[] = [];
  private errors: Buffer[] = [];
  private outputBytes = 0;
  private errorBytes = 0;
  constructor(
    private outputLimit = 96 * 1024 * 1024,
    private errorLimit = 128 * 1024,
  ) {}
  push(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      const channel = this.pending[0],
        size = this.pending.readUInt32BE(4);
      if (![1, 2].includes(channel) || size > 16 * 1024 * 1024) throw new BuildError("invalidWorkerStream", 502);
      if (this.pending.length < 8 + size) return;
      const data = this.pending.subarray(8, 8 + size);
      if (channel === 1) {
        this.outputBytes += data.length;
        if (this.outputBytes > this.outputLimit) throw new BuildError("workerOutputTooLarge", 502);
        this.output.push(Buffer.from(data));
      } else if (this.errorBytes < this.errorLimit) {
        const part = data.subarray(0, this.errorLimit - this.errorBytes);
        this.errors.push(Buffer.from(part));
        this.errorBytes += part.length;
      }
      this.pending = this.pending.subarray(8 + size);
    }
  }
  stderr() {
    return Buffer.concat(this.errors);
  }
  finish() {
    if (this.pending.length) throw new BuildError("incompleteWorkerStream", 502);
    return { stdout: Buffer.concat(this.output), stderr: this.stderr() };
  }
}
export function attachWorker(
  socketPath: string,
  name: string,
  input: Buffer,
  signal: AbortSignal,
  logs: (text: string) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const streams = new DockerStreams();
    const req = request({
      socketPath,
      method: "POST",
      path: `/v1.45/containers/${name}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=1`,
      headers: { Connection: "Upgrade", Upgrade: "tcp" },
      signal,
    });
    req.on("response", (response) => {
      response.resume();
      reject(new BuildError("workerStreamUpgradeFailed", 502));
    });
    req.on("error", () => reject(new BuildError(signal.aborted ? "buildInterrupted" : "workerStreamUnavailable", 503)));
    req.on("upgrade", (response, socket, head) => {
      socket.setTimeout(0);
      const abort = () => {
        socket.destroy(new BuildError("buildInterrupted", 409));
      };
      signal.addEventListener("abort", abort, { once: true });
      let ended = false;
      const receive = (data: Buffer) => {
        try {
          streams.push(data);
        } catch (error) {
          socket.destroy(error as Error);
        }
      };
      socket.on("data", receive);
      socket.on("error", reject);
      socket.on("end", () => {
        ended = true;
        try {
          resolve(streams.finish().stdout);
        } catch (error) {
          reject(error);
        }
      });
      socket.on("close", () => {
        signal.removeEventListener("abort", abort);
        try {
          logs(utf8Prefix(streams.stderr(), 128 * 1024));
        } catch {
          reject(new BuildError("workerLogUnavailable", 503));
        }
        if (!ended) reject(new BuildError("workerStreamClosed", 502));
      });
      if (head.length) receive(head);
      if (signal.aborted) abort();
      else socket.write(input);
    });
    req.setTimeout(30000, () => req.destroy(new BuildError("workerStreamTimeout", 504)));
    req.end();
  });
}
