import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { openSourceStageDatabase } from "../../src/server/packages/staging/database.js";
import { SqliteSourceStages } from "../../src/server/packages/staging/repository.js";
import { FileSourceStageNamespaces } from "../../src/server/packages/staging/files.js";
import { PackageSourceStages } from "../../src/server/packages/staging/service.js";
import { LocalSourceNamespaceActivity } from "../../src/server/packages/staging/activity.js";
import type { SourceStageFiles } from "../../src/server/packages/staging/ports.js";
import type { SourceStageCapacity } from "../../src/server/packages/staging/records.js";
import { DEFAULT_SOURCE_LIMITS } from "../../src/shared/packages/sources/contracts.js";
import { captureSourceSnapshot } from "../../src/shared/packages/sources/snapshot.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";

export const stageLimits = {
  ...DEFAULT_SOURCE_LIMITS,
  totalBytes: 1024 * 1024,
  archiveBytes: 1024 * 1024,
  fileBytes: 512 * 1024,
  files: 32,
  entries: 64,
};
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
export async function sourceStageFixture(capacity?: SourceStageCapacity) {
  const root = await mkdtemp(join(tmpdir(), "panda-source-staging-")),
    database = join(root, "stages.sqlite"),
    contentRoot = join(root, "files"),
    activity = new LocalSourceNamespaceActivity(),
    files = new FileSourceStageNamespaces(contentRoot, activity),
    archive = zipSync({
      "theme/layout/index.ejs": new TextEncoder().encode("<h1>Private original theme body</h1>"),
      "theme/logo.png": new Uint8Array([0, 255, 8]),
      "theme/文档.txt": new TextEncoder().encode("存储原文"),
    }),
    reader = await openZipSource(archive, "theme.zip", stageLimits),
    snapshot = await captureSourceSnapshot(reader, undefined, archive, stageLimits);
  let now = 1000,
    db = openSourceStageDatabase(database),
    store = new SqliteSourceStages(db, capacity);
  const service = (storage: SourceStageFiles = files, timeout = 1000, purpose: "templates" | "skills" = "templates") =>
    new PackageSourceStages(purpose, store, storage, stageLimits, () => now, timeout);
  return {
    root,
    database,
    contentRoot,
    files,
    activity,
    archive,
    snapshot,
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    now: () => now,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    service,
    request(selected?: string[] | null) {
      return {
        source: {
          kind: "zip-upload",
          name: "theme.zip",
          bytes: archive.length,
          sha256: reader.origin.kind === "zip-upload" ? reader.origin.archiveSha256 : "",
        },
        ...(selected === undefined ? {} : { selected }),
      };
    },
    restart() {
      db.close();
      db = openSourceStageDatabase(database);
      store = new SqliteSourceStages(db, capacity);
      return service();
    },
    async dispose() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
