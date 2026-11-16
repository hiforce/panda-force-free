import { expect, test } from "bun:test";
import { ProjectContentReadView } from "../../src/server/project-content/read-view.js";
import type { ProjectWorkingFiles } from "../../src/server/project-content/working-files.js";
import type { ProjectGitLease } from "../../src/server/project-content/git/lease.js";
import type { ProjectFileReader } from "../../src/server/project-content/file-reader.js";
import { PROJECT_CONTENT_LIMITS } from "../../src/server/project-content/limits.js";
import { projectBlobHash } from "../../src/server/project-content/git/blob-hash.js";

function gate() {
  let resolve = () => {};
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  return { ready, resolve: () => resolve() };
}

test("a completed body read cannot escape after its view closes during final file inspection", async () => {
  const bytes = Buffer.from("source"),
    completedBody = gate(),
    finishInspection = gate();
  const files = {
    async inspect(_path: string, work: (file: ProjectFileReader) => Promise<unknown>) {
      const result = await work({ size: bytes.length, read: async () => bytes });
      completedBody.resolve();
      await finishInspection.ready;
      return result;
    },
  } as unknown as ProjectWorkingFiles;
  const view = new ProjectContentReadView("a".repeat(40), new Map([["tree.json", projectBlobHash(bytes)]]), files, {
    assertHeld() {},
  } as ProjectGitLease);
  const pending = view.read("tree.json");
  await completedBody.ready;
  view.close();
  finishInspection.resolve();
  await expect(pending).rejects.toThrow("unavailable");
});

test("a late missing-file result cannot become a successful read after its view closes", async () => {
  const lookup = gate();
  const files = {
    async inspect() {
      await lookup.ready;
      throw Object.assign(Error("Missing file"), { code: "ENOENT" });
    },
  } as unknown as ProjectWorkingFiles;
  const view = new ProjectContentReadView("a".repeat(40), new Map(), files, { assertHeld() {} } as ProjectGitLease);
  const pending = view.read("project.json");
  view.close();
  lookup.resolve();
  await expect(pending).rejects.toThrow("unavailable");
});

test("concurrent full reads reserve the operation budget before starting body IO", async () => {
  const reads: string[] = [],
    releases: (() => void)[] = [],
    paths = ["project.json", "tree.json", "documents/doc-1.panda.json"];
  const files = {
    inspect(path: string, work: (file: ProjectFileReader) => Promise<unknown>) {
      return work({
        size: PROJECT_CONTENT_LIMITS.fileBytes,
        read: () => {
          reads.push(path);
          return new Promise<Buffer>((resolve) => {
            releases.push(() => resolve(Buffer.alloc(0)));
          });
        },
      });
    },
  } as unknown as ProjectWorkingFiles;
  const view = new ProjectContentReadView("a".repeat(40), new Map(paths.map((path) => [path, "b".repeat(40)])), files, {
    assertHeld() {},
  } as ProjectGitLease);
  const first = view.read(paths[0]!),
    second = view.read(paths[1]!),
    third = view.read(paths[2]!);
  await expect(third).rejects.toThrow("invalidFile");
  expect(reads).toEqual(paths.slice(0, 2));
  const settled = Promise.allSettled([first, second]);
  for (const release of releases) release();
  expect((await settled).map((row) => row.status)).toEqual(["rejected", "rejected"]);
  view.close();
});

test("partial inspections also reserve their shared byte budget before concurrent IO", async () => {
  let reads = 0;
  const pending: (() => void)[] = [];
  const files = {
    inspect(_path: string, work: (file: ProjectFileReader) => Promise<unknown>) {
      return work({
        size: PROJECT_CONTENT_LIMITS.fileBytes,
        read: () => {
          reads++;
          return new Promise<Buffer>((resolve) => {
            pending.push(() => resolve(Buffer.alloc(0)));
          });
        },
      });
    },
  } as unknown as ProjectWorkingFiles;
  const view = new ProjectContentReadView("a".repeat(40), new Map([["tree.json", "b".repeat(40)]]), files, {
    assertHeld() {},
  } as ProjectGitLease);
  const results: Promise<Buffer>[] = [];
  await view.inspect("tree.json", async (file) => {
    for (let n = 0; n < PROJECT_CONTENT_LIMITS.operationBytes / 65536; n++) results.push(file.read(0, 65536));
    await expect(file.read(0, 65536)).rejects.toThrow("invalidFile");
    expect(reads).toBe(PROJECT_CONTENT_LIMITS.operationBytes / 65536);
    for (const resolve of pending) resolve();
    await Promise.all(results);
  });
  view.close();
});
