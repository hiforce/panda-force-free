import { randomUUID } from "node:crypto";
import type { SftpConnectionInput } from "../../shared/connections/contracts.js";
import type { RemoteFileFactory, RemoteFiles, RemoteSite, RemoteSites } from "../../shared/connections/remote-files.js";
import { RemoteFileError } from "../../shared/connections/remote-files.js";

/** Dedicated, canonical directories prevent probes or publishers from taking over existing remote files. */
class SftpSite implements RemoteSite {
  readonly path: string;
  constructor(
    readonly files: RemoteFiles,
    private connection: SftpConnectionInput,
  ) {
    this.path = connection.directory;
  }
  private async directories(create = false) {
    let current = "",
      missing = false;
    for (const part of this.path.slice(1).split("/")) {
      current += "/" + part;
      const info = await this.files.stat(current);
      if (!info) {
        if (create) await this.files.mkdir(current, 0o755);
        else {
          missing = true;
          continue;
        }
      } else if (info.kind !== "directory" || missing) throw new RemoteFileError("invalidRemotePath");
      if ((await this.files.realpath(current)) !== current) throw new RemoteFileError("invalidRemotePath");
    }
  }
  private async owner() {
    const path = this.path + "/.panda-site.json";
    if (!(await this.files.stat(path))) return null;
    try {
      const value = JSON.parse(new TextDecoder().decode(await this.files.read(path, 1024)));
      if (value.version !== 1 || typeof value.connectionId !== "string") throw new Error("Invalid marker");
      return value.connectionId as string;
    } catch (error) {
      if (error instanceof RemoteFileError && error.code === "disconnected") throw error;
      throw new RemoteFileError("invalidRemotePath");
    }
  }
  async inspect() {
    await this.directories();
    if (!(await this.files.stat(this.path))) return;
    const owner = await this.owner();
    if (owner ? owner !== this.connection.id : (await this.files.list(this.path)).length > 0)
      throw new RemoteFileError("invalidRemotePath");
  }
  async claim() {
    await this.inspect();
    await this.directories(true);
    if (!(await this.owner()))
      await this.files.write(
        this.path + "/.panda-site.json",
        new TextEncoder().encode(JSON.stringify({ version: 1, connectionId: this.connection.id })),
        0o600,
      );
    await this.assertOwned();
  }
  async assertOwned() {
    await this.directories();
    if ((await this.owner()) !== this.connection.id) throw new RemoteFileError("invalidRemotePath");
  }
  async probe() {
    await this.claim();
    if ((await this.files.list(this.path)).filter((entry) => entry.name.startsWith(".panda-probe-")).length >= 5)
      throw new RemoteFileError("remoteLimit");
    const path = this.path + "/.panda-probe-" + randomUUID();
    await this.files.mkdir(path, 0o700);
    try {
      await this.files.write(path + "/check", new Uint8Array([1, 2, 3]), 0o600);
      if ((await this.files.read(path + "/check", 3)).join() !== "1,2,3") throw new RemoteFileError("operationFailed");
      await this.files.symlink("old", path + "/current");
      let exclusive = false;
      try {
        await this.files.symlink("overwrite", path + "/current");
      } catch (error) {
        if (error instanceof RemoteFileError && error.code === "operationFailed") exclusive = true;
        else throw error;
      }
      if (!exclusive || (await this.files.readlink(path + "/current")) !== "old")
        throw new RemoteFileError("unsupported");
      await this.files.symlink("new", path + "/next");
      await this.files.atomicRename(path + "/next", path + "/current");
      if ((await this.files.readlink(path + "/current")) !== "new") throw new RemoteFileError("unsupported");
    } finally {
      // Unique probe paths are the only artifacts a capability test may remove.
      for (const name of ["check", "current", "next"])
        if (await this.files.stat(path + "/" + name)) await this.files.unlink(path + "/" + name);
      await this.files.rmdir(path);
    }
  }
  close() {
    this.files.close();
  }
}
export class SftpSites implements RemoteSites {
  constructor(private factory: RemoteFileFactory) {}
  async connect(connection: SftpConnectionInput, credential: Record<string, unknown>) {
    return new SftpSite(await this.factory.connect(connection, credential), connection);
  }
}
