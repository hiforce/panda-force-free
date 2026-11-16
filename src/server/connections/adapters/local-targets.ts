import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapMetadata } from "../../../shared/async-value.js";
import type { LocalConnectionInput, PublicationRoot } from "../../../shared/connections/contracts.js";
import { ConnectionError } from "../errors.js";
import type { LocalTargetPolicy } from "../target-port.js";

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const overlap = (a: string, b: string) => within(a, b) || within(b, a);
function present(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Only administrator-registered roots may receive generated sites. Child symlinks are never followed. */
export class LocalTargets implements LocalTargetPolicy {
  private registered: PublicationRoot[];
  constructor(
    roots: PublicationRoot[],
    private protectedRoots: () => string[] | Promise<string[]>,
  ) {
    this.registered = roots.map((root) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(root.id) || !isAbsolute(root.path))
        throw new ConnectionError("invalidRoots", 503);
      const path = realpathSync(root.path);
      if (!lstatSync(path).isDirectory() || path === sep) throw new ConnectionError("invalidRoots", 503);
      return { id: root.id, path };
    });
    if (new Set(this.registered.map((root) => root.id)).size !== roots.length || roots.length > 20)
      throw new ConnectionError("invalidRoots", 503);
  }
  roots() {
    return this.registered.map((root) => ({ ...root }));
  }
  resolve(input: Pick<LocalConnectionInput, "root" | "directory">) {
    const root = this.registered.find((root) => root.id === input.root);
    if (!root || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(input.directory))
      throw new ConnectionError("invalidPath");
    const path = resolve(root.path, input.directory);
    this.checkWithRoots(path, []);
    return path;
  }
  check(path: string): void | Promise<void> {
    return mapMetadata(this.protectedRoots(), (roots) => this.checkWithRoots(path, roots));
  }
  private checkWithRoots(path: string, protectedRoots: readonly string[]) {
    const root = this.registered.find((root) => path !== root.path && within(path, root.path));
    if (!root || realpathSync(root.path) !== root.path) throw new ConnectionError("invalidPath");
    for (const protectedRoot of protectedRoots) {
      const canonical = present(protectedRoot) ? realpathSync(protectedRoot) : resolve(protectedRoot);
      if (overlap(path, canonical)) throw new ConnectionError("protectedPath", 403);
    }
    let current = root.path;
    for (const part of relative(root.path, path).split(sep)) {
      current = join(current, part);
      const info = present(current);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new ConnectionError("invalidPath");
    }
  }
  private owner(path: string): string | null {
    const marker = join(path, ".panda-site.json"),
      info = present(marker);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new ConnectionError("targetInUse", 409);
    try {
      const value = JSON.parse(readFileSync(marker, "utf8"));
      if (value.version !== 1 || typeof value.connectionId !== "string") throw new Error("Invalid marker");
      return value.connectionId;
    } catch {
      throw new ConnectionError("targetInUse", 409);
    }
  }
  inspectSync(path: string, connectionId: string): void | Promise<void> {
    return mapMetadata(this.check(path), () => {
      if (!present(path)) return;
      const owner = this.owner(path);
      if (owner ? owner !== connectionId : readdirSync(path).length > 0) throw new ConnectionError("targetInUse", 409);
    });
  }
  async inspect(path: string, connectionId: string) {
    await this.inspectSync(path, connectionId);
  }
  claim(path: string, connectionId: string): void | Promise<void> {
    return mapMetadata(this.inspectSync(path, connectionId), () => {
      mkdirSync(path, { recursive: true, mode: 0o755 });
      return mapMetadata(this.check(path), () => {
        if (!this.owner(path)) {
          try {
            writeFileSync(join(path, ".panda-site.json"), JSON.stringify({ version: 1, connectionId }), {
              flag: "wx",
              mode: 0o600,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        return mapMetadata(this.assertOwned(path, connectionId), () => {
          const sync = (file: string) => {
            const fd = openSync(file, "r");
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          };
          sync(join(path, ".panda-site.json"));
          const root = this.registered.find((root) => within(path, root.path))!;
          for (let parent = path; ; parent = dirname(parent)) {
            sync(parent);
            if (parent === root.path) break;
          }
        });
      });
    }) as void | Promise<void>;
  }
  assertOwned(path: string, connectionId: string): void | Promise<void> {
    return mapMetadata(this.check(path), () => {
      if (this.owner(path) !== connectionId) throw new ConnectionError("targetInUse", 409);
    });
  }
  async test(path: string, connectionId: string) {
    await this.claim(path, connectionId);
    const probe = join(path, ".panda-probe-" + randomUUID());
    await mkdir(probe, { mode: 0o700 });
    try {
      await symlink("unpublished-test", join(probe, "next"));
      await rename(join(probe, "next"), join(probe, "current"));
      if ((await readlink(join(probe, "current"))) !== "unpublished-test")
        throw new ConnectionError("unavailable", 503);
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  }
}
