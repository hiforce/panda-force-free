import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyRichBody } from "../../src/shared/documents/rich-body.js";
import { projectGit } from "../../src/server/project-content/git/process.js";
import { encodeProjectLegacyImport } from "../../src/server/project-content/migration/import-file.js";
import { openOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { draftAuthor } from "../support/project-draft-fixture.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

const query = "?project=project-1&id=doc-1",
  editorPath = "/api/project-documents/editor" + query,
  sourcePath = "/api/project-documents/source" + query,
  checkpointPath = "/api/project-documents/checkpoints" + query;
function draft(operationId = "draft-1", version = 0, baseRevisionId = "doc-1-rev-1") {
  return {
    operationId,
    version,
    baseRevisionId,
    working: { title: "Working title", locale: "en", content: "Working text\r\n", resources: [] },
  };
}
const checkpoint = (operationId = "save-1", draftVersion = 1, revisionId = "doc-1-rev-1") => ({
  operationId,
  draftVersion,
  revisionId,
});

test.concurrent(
  "an unavailable configured content root remains an error and recovery never initializes a replacement",
  async () => {
    const f = await projectFileApiFixture(),
      moved = f.root + "-offline";
    let offline = false;
    try {
      const original = await f.call(sourcePath);
      await rename(f.root, moved);
      offline = true;
      f.reopen();
      expect((await f.call(sourcePath)).status).toBe(503);
      await expect(readdir(f.root)).rejects.toMatchObject({ code: "ENOENT" });
      await rename(moved, f.root);
      offline = false;
      f.reopen();
      expect((await f.call(sourcePath)).body).toEqual(original.body);
    } finally {
      if (offline) await rename(moved, f.root);
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file editor HTTP separates durable autosaves, saved sources and explicit Git checkpoints across restart",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const original = await f.call(sourcePath),
        first = await f.call(editorPath),
        head = await f.snapshots.head();
      expect(original.status).toBe(200);
      expect(first.body.saved).toEqual(original.body);
      expect(first.body.draft).toMatchObject({ version: 0, dirty: false, stale: false });
      expect(first.body.draft).not.toHaveProperty("content");
      const savedDraft = await f.call(editorPath, "PUT", draft());
      expect(savedDraft.status).toBe(200);
      expect(savedDraft.body.receipt).toMatchObject({ operationId: "draft-1", version: 1 });
      expect(savedDraft.body.receipt).not.toHaveProperty("actor");
      expect(savedDraft.body.receipt).not.toHaveProperty("requestHash");
      expect(savedDraft.body.receipt).not.toHaveProperty("content");
      expect(await f.snapshots.head()).toBe(head);
      f.reopen();
      const resumed = await f.call(editorPath);
      expect(resumed.body.working).toEqual(draft().working);
      expect(resumed.body.draft).toMatchObject({ version: 1, dirty: true, stale: false });
      expect(resumed.body.saved).toEqual(original.body);
      expect((await f.call(sourcePath)).body).toEqual(original.body);
      expect((await f.call("/api/project-documents/revisions" + query)).body.revisions).toHaveLength(1);
      const saved = await f.call(checkpointPath, "POST", checkpoint());
      expect(saved.status).toBe(200);
      expect(saved.body.changed).toBe(true);
      expect(saved.body.detail.revision.content).toBe(draft().working.content);
      expect(saved.body.detail.document.revision).toBe(2);
      expect(saved.body.commit).toBe(await f.snapshots.head());
      expect((await f.call(editorPath)).body.draft).toMatchObject({ dirty: false, stale: false, version: 1 });
      const newer = draft("draft-2", 1, saved.body.detail.revision.id);
      newer.working.content = "A newer working copy";
      await f.call(editorPath, "PUT", newer);
      expect((await f.call(editorPath, "PUT", draft())).body).toEqual(savedDraft.body);
      expect((await f.call(checkpointPath, "POST", checkpoint())).body).toEqual(saved.body);
      expect((await f.call(editorPath)).body.working.content).toBe(newer.working.content);
      const second = await f.call(checkpointPath, "POST", checkpoint("save-2", 2, saved.body.detail.revision.id));
      expect(second.status).toBe(200);
      const history = await f.call("/api/project-documents/revisions" + query);
      expect(history.body.revisions.map((row: { number: number }) => row.number)).toEqual([3, 2, 1]);
      expect(history.body.revisions.some((row: object) => "content" in row || "body" in row)).toBe(false);
      expect(
        (await f.call("/api/project-documents/revisions" + query + "&revision=" + saved.body.detail.revision.id)).body
          .revision.content,
      ).toBe(draft().working.content);
      expect((await readdir(f.root)).sort()).toEqual(["projects"]);
      const author = (await projectGit(f.owned.directory, ["log", "-1", "--format=%ae"])).toString().trim();
      expect(author).toBe(
        createHash("sha256").update("operator:test-user").digest("hex") + "@operators.pandaforce.local",
      );
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file editor HTTP checks origin, project membership, actor-bound receipts and revoked cached access",
  async () => {
    const f = await projectFileApiFixture();
    try {
      expect((await fetch(f.base + editorPath)).status).toBe(401);
      expect((await f.call(editorPath, "PUT", draft(), { origin: "https://attacker.example" })).status).toBe(403);
      expect((await f.call(editorPath, "PUT", { ...draft(), author: { name: "Forged" } })).status).toBe(400);
      expect((await f.call(editorPath, "PUT", { ...draft(), actor: "forged" })).status).toBe(400);
      expect(
        (await f.call(editorPath, "PUT", { ...draft(), working: { ...draft().working, resources: null } })).status,
      ).toBe(400);
      expect((await f.call(editorPath + "-missing")).status).toBe(404);
      expect((await f.call("/api/project-documents/editor?project=other&id=doc-1")).status).toBe(404);
      f.grants.add("other");
      expect((await f.call("/api/project-documents/editor?project=other&id=doc-1")).status).toBe(404);
      expect((await readdir(join(f.root, "projects"))).sort()).toEqual(["project-1"]);
      await mkdir(join(f.root, "projects", "other"));
      expect((await f.call("/api/project-documents/editor?project=other&id=doc-1")).status).toBe(503);
      expect(await readdir(join(f.root, "projects", "other"))).toEqual([]);
      expect((await f.call(editorPath)).status).toBe(200);
      const first = await f.call(editorPath, "PUT", draft());
      expect(first.status).toBe(200);
      f.actor("operator:other-user");
      expect((await f.call(editorPath, "PUT", draft())).status).toBe(409);
      f.actor("operator:test-user");
      expect((await f.call(editorPath, "PUT", draft())).body).toEqual(first.body);
      const checks = f.state.authorizations;
      f.grants.delete("project-1");
      expect((await f.call(editorPath)).status).toBe(404);
      expect((await f.call(checkpointPath, "POST", checkpoint())).status).toBe(404);
      expect(f.state.authorizations).toBeGreaterThan(checks);
      expect((await f.project.documents.get("doc-1")).document.revision).toBe(1);
      expect((await f.project.drafts.get("doc-1")).version).toBe(1);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file editor preserves stale work, rejects stale generations and restores history without overwriting drafts",
  async () => {
    const f = await projectFileApiFixture();
    try {
      await f.call(editorPath, "PUT", draft());
      const external = projectDocumentFixture(2, "doc-1", "Externally saved original");
      await f.project.documents.put(external, 1, "external-change", draftAuthor);
      expect((await f.call(editorPath)).body.draft).toMatchObject({ dirty: true, stale: true, version: 1 });
      expect((await f.call(checkpointPath, "POST", checkpoint("stale", 1, external.revision.id))).status).toBe(409);
      expect(
        (
          await f.call(editorPath, "DELETE", {
            operationId: "discard",
            version: 1,
            baseRevisionId: external.revision.id,
          })
        ).status,
      ).toBe(200);
      expect((await f.call(editorPath, "PUT", draft("late", 1, external.revision.id))).status).toBe(409);
      const next = draft("fresh", 2, external.revision.id);
      next.working.content = "Keep this new working copy";
      expect((await f.call(editorPath, "PUT", next)).status).toBe(200);
      expect((await f.call(checkpointPath, "POST", checkpoint("wrong-version", 2, external.revision.id))).status).toBe(
        409,
      );
      const restore = { ...checkpoint("restore", 3, external.revision.id), restoreRevisionId: f.detail.revision.id },
        restored = await f.call("/api/project-documents/checkpoints/restore" + query, "POST", restore);
      expect(restored.status).toBe(200);
      expect(restored.body.detail.document.revision).toBe(3);
      expect(restored.body.detail.revision.content).toBe(f.detail.revision.content);
      expect((await f.call(editorPath)).body).toMatchObject({
        working: next.working,
        draft: { stale: true, dirty: true },
      });
      expect((await f.call("/api/project-documents/checkpoints/restore" + query, "POST", restore)).body).toEqual(
        restored.body,
      );
      expect((await f.call("/api/project-documents/revisions" + query)).body.revisions).toHaveLength(3);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "incomplete legacy imports block file application reads and writes until verified finalization",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const imported = {
        schema: 1 as const,
        projectId: "project-1",
        state: "importing" as const,
        sourceHash: "a".repeat(64),
        sourceSchema: 6,
        navigationSchema: 2,
        folders: [],
      };
      await f.project.coordinator.mutate({
        operationId: "begin-import",
        author: draftAuthor,
        message: "Record test import",
        changes: [{ path: "import.json", content: encodeProjectLegacyImport(imported) }],
      });
      const head = await f.snapshots.head();
      for (const result of [
        await f.call(sourcePath),
        await f.call(editorPath),
        await f.call(editorPath, "PUT", draft()),
      ]) {
        expect(result.status).toBe(503);
        expect(result.body.messageId).toBe("documents.unavailable");
        expect(JSON.stringify(result.body)).not.toContain(f.root);
        expect(JSON.stringify(result.body)).not.toContain(imported.sourceHash);
      }
      expect(await f.snapshots.head()).toBe(head);
      expect((await f.project.drafts.get("doc-1")).version).toBe(0);
      await f.project.coordinator.mutate({
        operationId: "finish-import",
        author: draftAuthor,
        message: "Finalize test import",
        changes: [{ path: "import.json", content: encodeProjectLegacyImport({ ...imported, state: "complete" }) }],
      });
      expect((await f.call(editorPath)).status).toBe(200);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file catalog uses metadata-only search while source reads validate exact originals and exclude trash",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const other = projectDocumentFixture(1, "other");
      other.document.title = other.revision.title = "Caf\u00e9 notes";
      await f.project.documents.put(other, null, "other-document", draftAuthor);
      const catalog = "/api/project-documents/catalog?project=project-1&space=space-1";
      expect(
        (await f.call(catalog + "&search=Cafe%CC%81")).body.documents.map((row: { id: string }) => row.id),
      ).toEqual(["other"]);
      expect((await f.call(catalog + "&offset=NaN")).status).toBe(400);
      expect((await f.call(catalog + "&offset=1")).body.documents).toHaveLength(1);
      const path = join(f.owned.directory, "documents", "other.panda.json"),
        original = await readFile(path),
        bytes = Buffer.from(original),
        offset = bytes.indexOf(Buffer.from('"content":'));
      expect(offset).toBeGreaterThan(0);
      const position = offset + Buffer.byteLength('"content":"');
      bytes[position] = bytes[position] === 120 ? 121 : 120;
      await writeFile(path, bytes);
      expect((await f.call(catalog)).status).toBe(200);
      expect((await f.call("/api/project-documents/source?project=project-1&id=other")).status).toBe(409);
      expect((await f.call("/api/project-documents/revisions?project=project-1&id=other")).status).toBe(200);
      await writeFile(path, original);
      await f.project.navigation.put(
        {
          spaceId: "space-1",
          version: 0,
          nodes: [{ documentId: "other", parentId: null, position: 0 }],
          trash: [{ documentId: "doc-1", deletedAt: 100, parentId: null, position: null, operationId: null }],
          origins: [],
          lastOperation: null,
        },
        null,
        "trash-document",
        draftAuthor,
      );
      expect((await f.call(catalog)).body.documents.map((row: { id: string }) => row.id)).toEqual(["other"]);
      expect((await f.call(sourcePath)).status).toBe(404);
      expect((await f.call(editorPath, "PUT", draft())).status).toBe(404);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "rich autosave canonicalizes projections and preserves raw-command receipts after later format changes",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const first = await f.call(editorPath, "PUT", draft()),
        body = emptyRichBody();
      body.document.content = [{ type: "paragraph", content: [{ type: "text", text: "Rich source" }] }];
      const rich = {
        ...draft("rich", 1),
        working: { ...draft().working, content: "Untrusted projection", body },
      };
      expect((await f.call(editorPath, "PUT", rich)).status).toBe(200);
      const state = await f.call(editorPath);
      expect(state.body.working.content).toContain("Rich source");
      expect(state.body.working.content).not.toContain("Untrusted projection");
      expect(state.body.working.body).toEqual(body);
      expect((await f.call(editorPath, "PUT", draft())).body).toEqual(first.body);
      expect((await f.call(editorPath, "PUT", draft("drop-rich", 2))).status).toBe(409);
      const saved = await f.call(checkpointPath, "POST", checkpoint("rich-checkpoint", 2));
      expect(saved.status).toBe(200);
      expect(saved.body.detail.revision.body).toEqual(body);
      expect((await f.call(editorPath, "PUT", draft())).body).toEqual(first.body);
      expect((await f.call(editorPath, "PUT", draft("drop-saved-rich", 2, saved.body.detail.revision.id))).status).toBe(
        409,
      );
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file opening never initializes missing repositories and a delayed authorization revocation blocks cached owners",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "panda-file-readonly-")),
      f = await projectFileApiFixture();
    try {
      await expect(openOwnedProjectDirectory(root, "absent")).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
      let checks = 0;
      const access = new DocumentFileProjects(f.root, async () => {
        if (++checks >= 2) throw new DocumentError("notFound", 404);
      });
      let entered = false;
      await expect(
        access.write("project-1", async () => {
          entered = true;
        }),
      ).rejects.toMatchObject({ code: "notFound" });
      expect(entered).toBe(false);
      const originalCommit = await f.snapshots.head(),
        next = projectDocumentFixture(2);
      await f.project.documents.put(next, 1, "later-revision", draftAuthor);
      expect(await f.project.documents.revisions("doc-1", 100, originalCommit)).toHaveLength(1);
      await expect(f.project.documents.revision("doc-1", next.revision.id, originalCommit)).rejects.toThrow("notFound");
      expect(await f.project.documents.revision("doc-1", f.detail.revision.id, originalCommit)).toEqual(
        f.detail.revision,
      );
    } finally {
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
