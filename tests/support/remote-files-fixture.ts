import { rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import type { RemoteFiles, RemoteEntry } from "../../src/shared/connections/remote-files.js";
import { RemoteFileError } from "../../src/shared/connections/remote-files.js";
import { createTemporaryDirectory } from "./temporary-directory.js";

/** A disposable filesystem transport allows faults before or after a remote side effect. */
export function remoteFilesFixture() {
  const root = createTemporaryDirectory("panda-remote-", { preferMemory: true });
  const calls: { operation: string; path: string }[] = [];
  let hook: (operation: string, path: string, stage: "before" | "after") => void | Promise<void> = () => {};
  const local = (path: string) => {
    if (!path.startsWith("/") || path.split("/").includes("..")) throw new Error("Unsafe fixture path");
    return join(root, path);
  };
  const entry = (name: string, info: Awaited<ReturnType<typeof fs.lstat>>): RemoteEntry => ({
    name,
    size: Number(info.size),
    kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  });
  async function call<T>(operation: string, path: string, action: () => Promise<T>) {
    calls.push({ operation, path });
    await hook(operation, path, "before");
    let result: T;
    try {
      result = await action();
    } catch (error) {
      if (error instanceof RemoteFileError) throw error;
      throw new RemoteFileError((error as NodeJS.ErrnoException).code === "ENOENT" ? "notFound" : "operationFailed");
    }
    await hook(operation, path, "after");
    return result;
  }
  const files: RemoteFiles = {
    stat: (path) =>
      call("stat", path, async () => {
        try {
          return entry(path, await fs.lstat(local(path)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
    realpath: (path) =>
      call("realpath", path, async () => {
        const actual = await fs.realpath(local(path));
        if (actual !== root && !actual.startsWith(root + sep)) throw new Error("Outside fixture");
        return "/" + relative(root, actual);
      }),
    list: (path) =>
      call("list", path, async () =>
        Promise.all(
          (await fs.readdir(local(path))).map(async (name) => entry(name, await fs.lstat(local(path + "/" + name)))),
        ),
      ),
    read: (path, maximum) =>
      call("read", path, async () => {
        const info = await fs.lstat(local(path));
        if (!info.isFile()) throw new RemoteFileError("invalidRemotePath");
        const bytes = await fs.readFile(local(path));
        if (bytes.length > maximum) throw new RemoteFileError("remoteLimit");
        return bytes;
      }),
    write: (path, bytes, mode) => call("write", path, () => fs.writeFile(local(path), bytes, { flag: "wx", mode })),
    mkdir: (path, mode) => call("mkdir", path, () => fs.mkdir(local(path), { mode })),
    rename: (from, to) => call("rename", to, () => fs.rename(local(from), local(to))),
    atomicRename: (from, to) => call("atomicRename", to, () => fs.rename(local(from), local(to))),
    symlink: (target, path) =>
      call("symlink", path, async () => {
        const resolved = resolve(local(path), "..", target);
        if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error("Outside fixture link");
        await fs.symlink(target, local(path));
      }),
    readlink: (path) => call("readlink", path, () => fs.readlink(local(path))),
    unlink: (path) => call("unlink", path, () => fs.unlink(local(path))),
    rmdir: (path) => call("rmdir", path, () => fs.rmdir(local(path))),
    close: () => {},
  };
  return {
    root,
    files,
    calls,
    fault: (next: typeof hook) => {
      hook = next;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
