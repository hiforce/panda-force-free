import { mkdirSync, lstatSync, realpathSync, openSync, fsyncSync, closeSync } from "node:fs";
import { rm, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PackageContentError } from "./file-bytes.js";

const sync = (path: string) => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

/** Root identity and one-time directory creation keep late writers from recreating removed content. */
export class OwnedContentDirectories {
  private root: string;
  private anchor: string;
  private inode: number;
  private device: number;
  constructor(
    root: string,
    private unavailable: () => Error = () => new PackageContentError("contentUnavailable"),
  ) {
    this.root = resolve(root);
    const created = mkdirSync(this.root, { recursive: true, mode: 0o700 }),
      stat = lstatSync(this.root);
    this.anchor = realpathSync(this.root);
    this.inode = stat.ino;
    this.device = stat.dev;
    this.directory();
    if (typeof created === "string") {
      let current = this.root;
      const last = dirname(resolve(created));
      for (;;) {
        sync(current);
        if (current === last) break;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  directory(): string {
    const stat = lstatSync(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.ino !== this.inode ||
      stat.dev !== this.device ||
      realpathSync(this.root) !== this.anchor
    )
      throw this.unavailable();
    return this.anchor;
  }
  path(id: string): string {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw this.unavailable();
    return join(this.directory(), id);
  }
  prepare(id: string) {
    mkdirSync(this.path(id), { mode: 0o700 });
    sync(this.directory());
  }
  async sync(id: string) {
    const directory = await open(this.path(id), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async remove(id: string) {
    await rm(this.path(id), { recursive: true, force: true });
    const parent = await open(this.directory(), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}
