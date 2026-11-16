import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, rename, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectDocumentFiles } from "../../src/server/project-content/document-store.js";
import { ProjectContentCoordinator } from "../../src/server/project-content/coordinator.js";
import { ProjectWorkingFiles } from "../../src/server/project-content/working-files.js";
import type { ProjectContentReadView } from "../../src/server/project-content/read-view.js";
import type { ProjectFileReader } from "../../src/server/project-content/file-reader.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";

const author = { name: "Document author", email: "document@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-document-metadata-")),
    owned = await createOwnedProjectDirectory(root, "project-1");
  return { root, owned, close: () => rm(root, { recursive: true, force: true }) };
}

test("metadata pages are bound to one saved project version and remain independent of original hydration", async () => {
  const f = await fixture();
  try {
    const store = new ProjectDocumentFiles(f.owned),
      one = projectDocumentFixture(1, "doc-1"),
      two = projectDocumentFixture(1, "doc-2", "a".repeat(1024 * 1024)),
      three = projectDocumentFixture(1, "doc-3");
    for (const value of [three, one, two]) await store.put(value, null, "create-" + value.document.id, author);
    const page = await store.metadataPage(2);
    expect(page.documents.map((row) => row.document.id)).toEqual(["doc-1", "doc-2"]);
    expect(page.documents.some((row) => "revision" in row || "body" in row)).toBe(false);
    const last = await store.metadataPage(2, page.nextCursor!);
    expect(last.documents.map((row) => row.document.id)).toEqual(["doc-3"]);
    expect(last.commit).toBe(page.commit);
    expect(last.nextCursor).toBeNull();
    expect((await store.metadata("doc-2")).document).toEqual(two.document);
    await expect(store.metadataPage(1, { commit: page.commit, after: "documents/missing.panda.json" })).rejects.toThrow(
      "invalidFile",
    );
    await expect(store.metadataPage(201)).rejects.toThrow("invalidFile");
    await expect(store.metadataPage(1, { commit: page.commit, after: "tree.json" })).rejects.toThrow("invalidFile");
    await expect(store.metadata("missing")).rejects.toThrow("notFound");
    const next = projectDocumentFixture(2);
    await store.put(next, 1, "save-next", author);
    await expect(store.metadataPage(2, page.nextCursor!)).rejects.toThrow("conflict");
    const path = join(f.owned.directory, "documents", "doc-2.panda.json");
    await writeFile(path, JSON.stringify({ document: { ...two.document, id: "foreign" }, revision: {}, schema: 1 }));
    await expect(store.metadata("doc-2")).rejects.toThrow("invalidFile");
    await unlink(join(f.owned.directory, "documents", "doc-3.panda.json"));
    await expect(store.metadata("doc-3")).rejects.toThrow("conflict");
  } finally {
    await f.close();
  }
}, 30000);

test("a scoped read view holds the project queue and cannot be reused after its callback", async () => {
  const f = await fixture();
  try {
    const coordinator = new ProjectContentCoordinator(f.owned);
    await coordinator.mutate({
      operationId: "initial",
      author,
      message: "Save tree",
      changes: [{ path: "tree.json", content: "first" }],
    });
    let capturedView: ProjectContentReadView | undefined,
      capturedReader: ProjectFileReader | undefined,
      updated = false;
    let queued: Promise<unknown> | undefined;
    await coordinator.view(async (view) => {
      capturedView = view;
      queued = coordinator
        .mutate({
          operationId: "next",
          author,
          message: "Update tree",
          changes: [{ path: "tree.json", content: "second" }],
        })
        .then(() => {
          updated = true;
        });
      await view.inspect("tree.json", async (file) => {
        capturedReader = file;
        expect((await file.read(0, file.size)).toString()).toBe("first");
      });
      expect((await view.read("tree.json"))?.toString()).toBe("first");
      expect(updated).toBe(false);
      expect(await view.read("project.json")).toBeNull();
    });
    await queued;
    expect(updated).toBe(true);
    expect((await coordinator.read(["tree.json"])).files.get("tree.json")?.toString()).toBe("second");
    await expect(capturedView!.read("tree.json")).rejects.toThrow("unavailable");
    await expect(capturedReader!.read(0, 1)).rejects.toThrow("unavailable");
    await writeFile(join(f.owned.directory, "project.json"), "untracked source");
    await expect(coordinator.read(["project.json"])).rejects.toThrow("conflict");
  } finally {
    await f.close();
  }
}, 30000);

test("bounded file inspections detect replacement, in-place changes and symlinks without following foreign files", async () => {
  const f = await fixture();
  try {
    const files = new ProjectWorkingFiles(f.owned),
      path = join(f.owned.directory, "tree.json"),
      foreign = join(f.root, "foreign.json");
    await writeFile(path, "first");
    let escaped: ProjectFileReader | undefined;
    expect(
      await files.inspect("tree.json", async (file) => {
        escaped = file;
        return (await file.read(0, 65536)).toString();
      }),
    ).toBe("first");
    await expect(escaped!.read(0, 1)).rejects.toThrow("unavailable");
    await writeFile(foreign, "other");
    await expect(
      files.inspect("tree.json", async (file) => {
        await rename(foreign, path);
        return file.read(0, 5);
      }),
    ).rejects.toThrow("conflict");
    await expect(
      files.inspect("tree.json", async (file) => {
        await writeFile(path, "changed length");
        return file.read(0, 5);
      }),
    ).rejects.toThrow("conflict");
    await writeFile(foreign, "foreign original");
    await unlink(path);
    await symlink(foreign, path);
    await expect(files.inspect("tree.json", async (file) => file.read(0, 1))).rejects.toThrow();
  } finally {
    await f.close();
  }
});
