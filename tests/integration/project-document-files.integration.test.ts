import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentDetail } from "../../src/shared/documents/contracts.js";
import { documentContentIdentity } from "../../src/shared/documents/content-identity.js";
import { ProjectDocumentFiles } from "../../src/server/project-content/document-store.js";
import { ProjectDocumentHistory } from "../../src/server/project-content/document-history.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectGit } from "../../src/server/project-content/git/process.js";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";

const author = { name: "Document author", email: "document@example.test" };
function detail(number: number): DocumentDetail {
  const content = "Original historical projection " + number + ".\r\n\n";
  const body: DocumentDetail["revision"]["body"] = {
    schema: 1,
    format: "richtext",
    document: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Rich original " + number, marks: [{ type: "bold" }] }] },
      ],
    },
  };
  const hash = createHash("sha256").update(documentContentIdentity(content, body)).digest("hex"),
    id = "doc-1",
    revisionId = "rev-" + number,
    title = "文档 " + number;
  return {
    document: {
      id,
      spaceId: "space-1",
      path: "original/guide.md",
      title,
      locale: "zh-CN",
      revision: number,
      revisionId,
      contentHash: hash,
      importedHash: null,
      importedRevision: null,
      updatedAt: 123400 + number,
    },
    revision: {
      id: revisionId,
      documentId: id,
      number,
      title,
      locale: "zh-CN",
      content,
      body,
      contentHash: hash,
      createdAt: 123400 + number,
      resources: [
        {
          source: "images/original.png",
          sourcePath: "source/images/original.png",
          assetId: "image-1",
          digest: "d".repeat(64),
        },
      ],
    },
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-document-files-")),
    owned = await createOwnedProjectDirectory(root, "project-1");
  return {
    root,
    owned,
    store: new ProjectDocumentFiles(owned),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("document files preserve immutable originals and replay the original result after later edits", async () => {
  const f = await fixture();
  try {
    const first = detail(1),
      second = detail(2),
      third = detail(3);
    expect(await f.store.put(first, null, "save-1", author)).toEqual(first);
    expect(await f.store.put(second, 1, "save-2", author)).toEqual(second);
    await f.store.put(third, 2, "save-3", author);
    const reopened = new ProjectDocumentFiles(f.owned);
    expect(await reopened.get("doc-1")).toEqual(third);
    expect(await reopened.revision("doc-1", "rev-1")).toEqual(first.revision);
    expect(await reopened.revision("doc-1", "rev-2")).toEqual(second.revision);
    expect(await reopened.put(first, null, "save-1", author)).toEqual(first);
    expect(await reopened.get("doc-1")).toEqual(third);
    expect((await projectGit(f.owned.directory, ["rev-list", "--count", "HEAD"])).toString().trim()).toBe("4");
    const history = await reopened.revisions("doc-1");
    expect(history.map((row) => row.id)).toEqual(["rev-3", "rev-2", "rev-1"]);
    expect(history[2]?.createdAt).toBe(first.revision.createdAt);
    expect(history.some((row) => "body" in row || "content" in row || "resources" in row)).toBe(false);
    expect(
      JSON.parse(await readFile(join(f.owned.directory, "documents", "doc-1.panda.json"), "utf8")).revision.content,
    ).toBe(third.revision.content);
    await expect(reopened.put(first, null, "save-1", { ...author, email: "other@example.test" })).rejects.toMatchObject(
      { code: "conflict" },
    );
    const modified = detail(1);
    modified.document.path = "different.md";
    await expect(reopened.put(modified, null, "save-1", author)).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await f.close();
  }
}, 30000);

test("file-backed revision listing uses metadata without hydrating original blobs or falling back to another store", async () => {
  const f = await fixture();
  try {
    await f.store.put(detail(1), null, "save-1", author);
    await f.store.put(detail(2), 1, "save-2", author);
    const history = await new ProjectDocumentHistory(f.owned).list("doc-1"),
      snapshots = new ProjectGitSnapshots(f.owned);
    for (const entry of history) {
      const blob = (await snapshots.entries(entry.commit)).find(
        (row) => row.path === "documents/doc-1.panda.json",
      )!.blob;
      await unlink(join(f.owned.directory, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    }
    const reopened = new ProjectDocumentFiles(f.owned);
    expect((await reopened.revisions("doc-1")).map((row) => row.id)).toEqual(["rev-2", "rev-1"]);
    expect(await reopened.get("doc-1")).toEqual(detail(2));
    await expect(reopened.revision("doc-1", "rev-1")).rejects.toThrow();
  } finally {
    await f.close();
  }
}, 30000);

test("independent document saves share one project transaction owner without spurious revision conflicts", async () => {
  const f = await fixture();
  try {
    const one = detail(1),
      other = detail(1);
    other.document.id = other.revision.documentId = "doc-2";
    other.document.path = "other/guide.md";
    other.document.revisionId = other.revision.id = "other-rev-1";
    other.revision.resources = [];
    const created = await Promise.all([
      f.store.put(one, null, "one-create", author),
      f.store.put(other, null, "other-create", author),
    ]);
    expect(created.map((row) => row.document.id)).toEqual(["doc-1", "doc-2"]);
    const next = detail(2),
      otherNext = detail(2);
    otherNext.document.id = otherNext.revision.documentId = "doc-2";
    otherNext.document.path = "other/guide.md";
    otherNext.document.revisionId = otherNext.revision.id = "other-rev-2";
    otherNext.revision.resources = [];
    await Promise.all([f.store.put(next, 1, "one-update", author), f.store.put(otherNext, 1, "other-update", author)]);
    expect(await f.store.get("doc-1")).toEqual(next);
    expect(await f.store.get("doc-2")).toEqual(otherNext);
    const stale = detail(3),
      competing = detail(3);
    competing.document.revisionId = competing.revision.id = "competing-rev-3";
    const outcomes = await Promise.allSettled([
      f.store.put(stale, 2, "one-third", author),
      f.store.put(competing, 2, "one-competing", author),
    ]);
    expect(outcomes.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
    expect((await f.store.get("doc-1")).revision.id).toBe("rev-3");
  } finally {
    await f.close();
  }
}, 30000);

test("queued future versions cannot reuse a revision identifier introduced by an earlier queued save", async () => {
  const f = await fixture();
  try {
    await f.store.put(detail(1), null, "initial", author);
    const second = detail(2),
      third = detail(3),
      fourth = detail(4);
    second.document.revisionId = second.revision.id = "queued-revision";
    fourth.document.revisionId = fourth.revision.id = "queued-revision";
    const results = await Promise.allSettled([
      f.store.put(second, 1, "queued-second", author),
      f.store.put(third, 2, "queued-third", author),
      f.store.put(fourth, 3, "queued-fourth", author),
    ]);
    expect(results.map((row) => row.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((await f.store.get("doc-1")).revision.id).toBe("rev-3");
    expect((await f.store.revisions("doc-1")).map((row) => row.id)).toEqual(["rev-3", "queued-revision", "rev-1"]);
  } finally {
    await f.close();
  }
}, 30000);

test("queued documents retain space-path uniqueness and cannot reuse another document's historical revision ID", async () => {
  const f = await fixture();
  try {
    await f.store.put(detail(1), null, "first", author);
    await f.store.put(detail(2), 1, "second", author);
    const other = detail(1);
    other.document.id = other.revision.documentId = "doc-2";
    other.document.revisionId = other.revision.id = "new-revision";
    await expect(f.store.put(other, null, "duplicate-path", author)).rejects.toThrow("conflict");
    other.document.path = "other.md";
    other.document.revisionId = other.revision.id = "rev-1";
    await expect(f.store.put(other, null, "historical-identity", author)).rejects.toThrow("conflict");
    other.document.revisionId = other.revision.id = "new-revision";
    const rival = structuredClone(other);
    rival.document.id = rival.revision.documentId = "doc-3";
    rival.document.revisionId = rival.revision.id = "rival-revision";
    const result = await Promise.allSettled([
      f.store.put(other, null, "new-document", author),
      f.store.put(rival, null, "rival-document", author),
    ]);
    expect(result.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
    expect((await f.store.get("doc-2")).document.path).toBe("other.md");
    await expect(f.store.get("doc-3")).rejects.toThrow("notFound");
  } finally {
    await f.close();
  }
}, 30000);

test("unknown live-file edits are preserved and stale, foreign or reused revision writes are rejected", async () => {
  const f = await fixture();
  try {
    await f.store.put(detail(1), null, "save-1", author);
    await f.store.put(detail(2), 1, "save-2", author);
    await expect(f.store.put(detail(3), 1, "stale", author)).rejects.toThrow();
    const reused = detail(3);
    reused.document.revisionId = reused.revision.id = "rev-1";
    await expect(f.store.put(reused, 2, "reused", author)).rejects.toMatchObject({ code: "conflict" });
    const foreign = detail(3);
    foreign.document.spaceId = "other-space";
    await expect(f.store.put(foreign, 2, "foreign", author)).rejects.toMatchObject({ code: "conflict" });
    const path = join(f.owned.directory, "documents", "doc-1.panda.json");
    await writeFile(path, "unknown manually edited bytes");
    await expect(f.store.get("doc-1")).rejects.toMatchObject({ code: "conflict" });
    await expect(f.store.put(detail(3), 2, "manual-conflict", author)).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path, "utf8")).toBe("unknown manually edited bytes");
    expect(await f.store.revision("doc-1", "rev-1")).toEqual(detail(1).revision);
    await expect(f.store.revision("doc-1", "missing")).rejects.toMatchObject({ code: "notFound" });
    await expect(f.store.get("../other")).rejects.toMatchObject({ code: "invalidFile" });
  } finally {
    await f.close();
  }
}, 30000);
