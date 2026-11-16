import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";

export interface FrozenSQLiteSource {
  id: string;
  originalPath: string | null;
  snapshotPath: string;
  sha256: string;
  bytes: number;
}
export async function snapshotDigest(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { sha256: hash.digest("hex"), bytes: info.size };
}
export async function verifyFrozenSQLiteSource(source: FrozenSQLiteSource) {
  const actual = await snapshotDigest(source.snapshotPath);
  if (actual.sha256 !== source.sha256 || actual.bytes !== source.bytes) throw Error("migrationSourceChanged");
}

/** Persist every new directory entry before a durable manifest can point to it. */
export async function synchronizeFrozenSourceDirectories(sources: readonly FrozenSQLiteSource[], root: string) {
  const boundary = resolve(root),
    directories = new Set<string>();
  for (const source of sources) {
    let parent = dirname(resolve(source.snapshotPath));
    const inside = relative(boundary, parent);
    if (inside.startsWith("..") || isAbsolute(inside)) throw Error("invalidMigrationSnapshot");
    for (;;) {
      directories.add(parent);
      if (parent === boundary) break;
      parent = dirname(parent);
    }
  }
  if (process.platform === "win32") return;
  for (const path of [...directories].sort((a, b) => b.length - a.length)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
    const file = await open(path, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

/** Caller must have stopped every application writer. VACUUM captures committed WAL rows without changing source schema or rows. */
export async function captureFrozenSQLiteSource(options: {
  id: string;
  directory: string;
  sourcePath?: string;
  initializeEmpty?: (path: string) => void | Promise<void>;
}): Promise<FrozenSQLiteSource> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.id)) throw Error("invalidMigrationSnapshot");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directory = await lstat(options.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
  const finalPath = join(options.directory, options.id + ".sqlite"),
    temporary = finalPath + "." + randomUUID();
  let originalPath: string | null = null;
  try {
    if (options.sourcePath) {
      try {
        const info = await lstat(options.sourcePath);
        if (!info.isFile() || info.isSymbolicLink()) throw Error("invalidMigrationSnapshot");
        originalPath = options.sourcePath;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (originalPath) {
      const source = new Database(originalPath, { readonly: true, strict: true });
      try {
        source.query("VACUUM INTO ?").run(temporary);
      } finally {
        source.close();
      }
    } else {
      if (!options.initializeEmpty) throw Error("migrationSourceMissing");
      await options.initializeEmpty(temporary);
    }
    const check = new Database(temporary, { readonly: true, strict: true });
    try {
      if (check.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw Error("invalidMigrationSnapshot");
    } finally {
      check.close();
    }
    await chmod(temporary, 0o400);
    const file = await open(temporary, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    // Never overwrite a previous frozen source, including after a response was lost.
    await link(temporary, finalPath);
    if (process.platform !== "win32") {
      const parent = await open(options.directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    const { sha256, bytes } = await snapshotDigest(finalPath);
    return { id: options.id, originalPath, snapshotPath: finalPath, sha256, bytes };
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Schema normalization happens on a separate copy; the original frozen bytes remain an independent recovery artifact. */
export async function prepareFrozenSQLiteSource(
  source: FrozenSQLiteSource,
  path: string,
  initialize: (path: string) => void | Promise<void>,
) {
  await verifyFrozenSQLiteSource(source);
  const temporary = path + "." + randomUUID();
  try {
    await copyFile(source.snapshotPath, temporary, 1);
    await chmod(temporary, 0o600);
    await initialize(temporary);
    const db = new Database(temporary, { readonly: true, strict: true });
    try {
      if (db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw Error("invalidMigrationSnapshot");
    } finally {
      db.close();
    }
    await chmod(temporary, 0o400);
    const file = await open(temporary, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const parent = await open(dirname(path), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    return { ...source, snapshotPath: path, ...(await snapshotDigest(path)) };
  } finally {
    await rm(temporary, { force: true });
  }
}
