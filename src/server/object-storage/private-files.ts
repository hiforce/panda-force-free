import { constants } from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, readdir, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ObjectStorageError } from "./contracts.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const conflict = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";
const fail = (): never => {
  throw new ObjectStorageError("storageIntegrity");
};
const maximum = 1024 * 1024;
const component = (value: string) =>
  /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value) && value !== "." && value !== ".." ? value : fail();
async function sync(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function inspectDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && stat.mode & 0o077)) fail();
  return stat;
}
async function createDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
    await sync(dirname(path));
  } catch (error) {
    if (!conflict(error)) throw error;
  }
  return inspectDirectory(path);
}
async function privateBytes(path: string, recovery = true): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || (process.platform !== "win32" && stat.mode & 0o077)) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > stat.size) fail();
    const after = await handle.stat(),
      current = await lstat(path);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      current.size !== stat.size ||
      current.mtimeMs !== stat.mtimeMs ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.isSymbolicLink()
    )
      fail();
    if (after.ctimeMs !== stat.ctimeMs || current.ctimeMs !== stat.ctimeMs) {
      if (!recovery || stat.nlink !== 2 || current.nlink !== 1) fail();
      const reread = await privateBytes(path, false);
      if (!reread || !reread.equals(buffer.subarray(0, length))) fail();
      return reread;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function publish(path: string, bytes: Uint8Array, verify: () => Promise<void>) {
  if (bytes.length > maximum) fail();
  const temporary = join(dirname(path), ".panda-storage-" + randomUUID()),
    handle = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    await verify();
    try {
      await link(temporary, path);
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
    await sync(dirname(path));
    return true;
  } finally {
    if (!closed) await handle.close();
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
interface StorageMarker {
  schema: 1;
  product: "PandaForce private original storage";
  installationId: string;
  namespaceKey: string;
}
function marker(bytes: Buffer): StorageMarker {
  const value = JSON.parse(bytes.toString()) as StorageMarker;
  if (
    !value ||
    value.schema !== 1 ||
    value.product !== "PandaForce private original storage" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.installationId) ||
    !/^[a-f0-9]{64}$/.test(value.namespaceKey) ||
    Object.keys(value).some((key) => !["schema", "product", "installationId", "namespaceKey"].includes(key))
  )
    fail();
  return value;
}

/** Complete immutable generations provide cross-process CAS without keeping a database or project lease during S3 IO. */
export class PrivateStorageFiles {
  private opening: Promise<{ base: string; marker: StorageMarker; verify(): Promise<void> }> | null = null;
  constructor(private readonly path: string) {
    if (!isAbsolute(path)) fail();
  }
  async present() {
    try {
      await inspectDirectory(this.path);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  private root() {
    return (this.opening ??= this.initialize().catch((error) => {
      this.opening = null;
      throw error;
    }));
  }
  private async initialize() {
    let created = false;
    try {
      await mkdir(this.path, { mode: 0o700 });
      created = true;
      await sync(dirname(this.path));
    } catch (error) {
      if (!conflict(error)) throw error;
    }
    const base = await realpath(this.path),
      stat = await inspectDirectory(this.path),
      path = join(base, "ownership.json");
    if (stat.isSymbolicLink()) fail();
    if (created)
      await publish(
        path,
        Buffer.from(
          JSON.stringify({
            schema: 1,
            product: "PandaForce private original storage",
            installationId: randomUUID(),
            namespaceKey: randomBytes(32).toString("hex"),
          }) + "\n",
        ),
        async () => {
          await inspectDirectory(this.path);
        },
      );
    let bytes = await privateBytes(path);
    // Concurrent initialization may have created the directory immediately before publishing its complete marker.
    for (let attempt = 0; !bytes && attempt < 40; attempt++) {
      await Bun.sleep(25);
      bytes = await privateBytes(path);
    }
    if (!bytes) fail();
    const identity = marker(bytes!);
    const verify = async () => {
      try {
        const current = await inspectDirectory(this.path),
          next = await privateBytes(path);
        if (!next || current.ino !== stat.ino || current.dev !== stat.dev || !next.equals(bytes!)) fail();
      } catch {
        fail();
      }
    };
    await verify();
    return { base, marker: identity, verify };
  }
  async installation() {
    const root = await this.root();
    await root.verify();
    return root.marker.installationId;
  }
  async scope(value: string) {
    const root = await this.root();
    await root.verify();
    return createHmac("sha256", root.marker.namespaceKey).update(value).digest("hex");
  }
  private async parent(parts: string[], create: boolean) {
    if (!parts.length || parts.length > 8) fail();
    const root = await this.root();
    await root.verify();
    let path = root.base;
    for (const part of parts.slice(0, -1)) {
      path = join(path, component(part));
      if (create) await createDirectory(path);
      else await inspectDirectory(path);
    }
    return { path: join(path, component(parts.at(-1)!)), verify: root.verify };
  }
  async read(parts: string[]): Promise<unknown | null> {
    if (!(await this.present())) return null;
    try {
      const target = await this.parent(parts, false),
        bytes = await privateBytes(target.path);
      await target.verify();
      return bytes === null ? null : JSON.parse(bytes.toString());
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async writeOnce(parts: string[], value: unknown) {
    const target = await this.parent(parts, true);
    const json = JSON.stringify(value);
    if (typeof json !== "string") fail();
    return publish(target.path, Buffer.from(json + "\n"), target.verify);
  }
  async list(parts: string[]) {
    if (!(await this.present())) return [];
    try {
      const target = await this.parent([...parts, "placeholder"], false),
        path = dirname(target.path),
        entries = await readdir(path, { withFileTypes: true });
      if (entries.length > 10000) fail();
      await target.verify();
      return entries
        .filter((entry) => entry.name.endsWith(".json") && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(entry.name))
        .map((entry) => {
          if (!entry.isFile() || entry.isSymbolicLink()) fail();
          return entry.name;
        })
        .sort();
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
  async directories(parts: string[]) {
    if (!(await this.present())) return [];
    try {
      const target = await this.parent([...parts, "placeholder"], false),
        entries = await readdir(dirname(target.path), { withFileTypes: true });
      if (entries.length > 10000) fail();
      await target.verify();
      return entries
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => {
          component(entry.name);
          if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
          return entry.name;
        })
        .sort();
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }
  async remove(parts: string[]) {
    const target = await this.parent(parts, false);
    const bytes = await privateBytes(target.path);
    if (bytes === null) return;
    await target.verify();
    await unlink(target.path).catch((error) => {
      if (!missing(error)) throw error;
    });
    await sync(dirname(target.path));
  }
}
