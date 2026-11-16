import { Client, type SFTPWrapper, type Stats } from "ssh2";
import type { RemoteEntry, RemoteFiles } from "../../shared/connections/remote-files.js";
import { RemoteFileError } from "../../shared/connections/remote-files.js";

function failure(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return new RemoteFileError(
    code === 2
      ? "notFound"
      : code === 3
        ? "permissionDenied"
        : code === 8 || (error instanceof Error && error.message.startsWith("Server does not support"))
          ? "unsupported"
          : "operationFailed",
  );
}
function entry(name: string, info: Stats): RemoteEntry {
  const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  const size = info.size ?? (kind === "file" ? NaN : 0);
  if (!Number.isSafeInteger(size) || size < 0) throw new RemoteFileError("remoteLimit");
  return { name, size, kind };
}
/** Every request is bounded. Disconnecting rejects pending operations without leaking server messages. */
export class SftpFiles implements RemoteFiles {
  private closed = false;
  private pending = new Set<() => void>();
  private lifetime: ReturnType<typeof setTimeout>;
  constructor(
    private client: Client,
    private sftp: SFTPWrapper,
    private timeout = 15000,
    lifetime = 300000,
  ) {
    this.lifetime = setTimeout(() => this.close(), lifetime);
    this.lifetime.unref();
    client.on("error", () => this.close());
    client.on("close", () => this.close());
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifetime);
    for (const reject of this.pending) reject();
    this.pending.clear();
    this.client.destroy();
  }
  private call<T>(invoke: (done: (error: Error | undefined, value: T) => void) => void): Promise<T> {
    if (this.closed) return Promise.reject(new RemoteFileError("disconnected"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: RemoteFileError | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(disconnected);
        if (error) reject(error);
        else resolve(value!);
      };
      const disconnected = () => finish(new RemoteFileError("disconnected"));
      const timer = setTimeout(() => this.close(), this.timeout);
      this.pending.add(disconnected);
      try {
        invoke((error, value) => finish(error ? failure(error) : null, value));
      } catch (error) {
        finish(failure(error));
      }
    });
  }
  private void(invoke: (done: (error?: Error | null) => void) => void) {
    return this.call<void>((done) => invoke((error) => done(error || undefined, undefined)));
  }
  async stat(path: string) {
    try {
      return entry(path, await this.call<Stats>((done) => this.sftp.lstat(path, done)));
    } catch (error) {
      if (error instanceof RemoteFileError && error.code === "notFound") return null;
      throw error;
    }
  }
  async realpath(path: string) {
    const result = await this.call<string>((done) => this.sftp.realpath(path, done));
    if (result.length > 1024 || !result.startsWith("/")) throw new RemoteFileError("invalidRemotePath");
    return result;
  }
  async list(path: string) {
    const handle = await this.call<Buffer>((done) => this.sftp.opendir(path, done));
    const items: import("ssh2").FileEntryWithStats[] = [];
    try {
      for (let reads = 0; ; reads++) {
        if (reads >= 3000) throw new RemoteFileError("remoteLimit");
        const batch = await this.call<import("ssh2").FileEntryWithStats[] | null>((done) =>
          this.sftp.readdir(handle, (error, list) =>
            (error as { code?: number })?.code === 1 ? done(undefined, null) : done(error, list),
          ),
        );
        if (batch === null) break;
        if (!Array.isArray(batch) || items.length + batch.length > 3000) throw new RemoteFileError("remoteLimit");
        items.push(...batch);
      }
    } finally {
      await this.void((done) => this.sftp.close(handle, done));
    }
    return items
      .filter((item) => ![".", ".."].includes(item.filename))
      .map((item) => {
        if (
          !item.filename ||
          item.filename.length > 255 ||
          /[\\/]/.test(item.filename) ||
          [...item.filename].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        )
          throw new RemoteFileError("invalidRemotePath");
        return entry(item.filename, item.attrs);
      });
  }
  async read(path: string, maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 64 * 1024 * 1024)
      throw new RemoteFileError("remoteLimit");
    const info = await this.stat(path);
    if (!info || info.kind !== "file") throw new RemoteFileError("invalidRemotePath");
    if (info.size > maximum) throw new RemoteFileError("remoteLimit");
    const handle = await this.call<Buffer>((done) => this.sftp.open(path, "r", done));
    try {
      const data = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < data.length) {
        const count = await this.call<number>((done) =>
          this.sftp.read(handle, data, length, Math.min(65536, data.length - length), length, (error, read) =>
            done(error || undefined, read),
          ),
        );
        if (!count) break;
        length += count;
      }
      if (length > maximum) throw new RemoteFileError("remoteLimit");
      return data.subarray(0, length);
    } finally {
      await this.void((done) => this.sftp.close(handle, done));
    }
  }
  async write(path: string, bytes: Uint8Array, mode: number) {
    if (bytes.byteLength > 64 * 1024 * 1024) throw new RemoteFileError("remoteLimit");
    const data = Buffer.from(bytes),
      handle = await this.call<Buffer>((done) => this.sftp.open(path, "wx", { mode }, done));
    try {
      for (let offset = 0; offset < data.length; offset += 65536)
        await this.void((done) =>
          this.sftp.write(handle, data, offset, Math.min(65536, data.length - offset), offset, done),
        );
      await this.call((done) => this.sftp.ext_openssh_fsync(handle, done));
    } finally {
      await this.void((done) => this.sftp.close(handle, done));
    }
  }
  mkdir(path: string, mode: number) {
    return this.void((done) => this.sftp.mkdir(path, { mode }, done));
  }
  rename(from: string, to: string) {
    return this.void((done) => this.sftp.rename(from, to, done));
  }
  atomicRename(from: string, to: string) {
    return this.void((done) => this.sftp.ext_openssh_rename(from, to, done));
  }
  symlink(target: string, path: string) {
    return this.void((done) => this.sftp.symlink(target, path, done));
  }
  async readlink(path: string) {
    const result = await this.call<string>((done) => this.sftp.readlink(path, done));
    if (result.length > 1024) throw new RemoteFileError("remoteLimit");
    return result;
  }
  unlink(path: string) {
    return this.void((done) => this.sftp.unlink(path, done));
  }
  rmdir(path: string) {
    return this.void((done) => this.sftp.rmdir(path, done));
  }
}
