import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { currentDraftContent } from "../../src/server/project-content/drafts/content.js";
import type { ProjectSourceEditCommand } from "../../src/server/project-content/source-edits.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { projectDraftFixture, draftAuthor, autosaveCommand } from "../support/project-draft-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function command(detail: ReturnType<typeof projectDocumentFixture>): ProjectSourceEditCommand {
  return {
    operationId: "source-edit-1",
    documentId: detail.document.id,
    expectedRevisionId: detail.revision.id,
    expectedVersion: detail.revision.number,
    expectedContentHash: detail.revision.contentHash,
    intentHash: digest("confirmed selection"),
    author: draftAuthor,
    content: { ...currentDraftContent(detail), content: "Reviewed saved source" },
  };
}

test.concurrent(
  "a saved edit has a native receipt, preserves source metadata and replays the same historical result after later work",
  async () => {
    const f = await projectDraftFixture();
    try {
      const input = command(f.detail),
        head = await f.snapshots.head();
      expect(await f.project.sourceEdits.receipt(input)).toBeNull();
      expect(await f.snapshots.head()).toBe(head);
      const pending = f.project.sourceEdits.apply(input);
      input.content.content = "A caller changed its object after submission";
      const applied = await pending;
      expect(applied.changed).toBe(true);
      expect(applied.detail.revision.content).toBe("Reviewed saved source");
      expect(applied.detail.document).toMatchObject({
        title: f.detail.document.title,
        path: f.detail.document.path,
        locale: f.detail.document.locale,
        importedHash: f.detail.document.importedHash,
        revision: 2,
      });
      expect(applied.detail.revision.id).not.toBe(f.detail.revision.id);
      const later = projectDocumentFixture(3, "doc-1", "Later saved content");
      await f.project.documents.put(later, 2, "later-content", draftAuthor);
      await f.project.drafts.put({
        ...autosaveCommand("later-draft", 0, later.revision.id),
        content: { ...currentDraftContent(later), content: "Unsaved later content" },
      });
      const reopened = new ProjectContentProject(f.owned),
        after = await f.snapshots.head();
      expect(await reopened.sourceEdits.receipt(command(f.detail))).toEqual(applied);
      expect(await reopened.sourceEdits.apply(command(f.detail))).toEqual(applied);
      expect(await f.snapshots.head()).toBe(after);
      expect((await reopened.drafts.get("doc-1")).content?.content).toBe("Unsaved later content");
      await expect(
        reopened.sourceEdits.apply({ ...command(f.detail), intentHash: digest("another selection") }),
      ).rejects.toThrow("conflict");
      await expect(
        reopened.sourceEdits.receipt({ ...command(f.detail), author: { ...draftAuthor, email: "other@example.test" } }),
      ).rejects.toThrow("conflict");
      expect(await f.snapshots.head()).toBe(after);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "saved edits refuse dirty drafts and stale revisions without erasing either working or saved content",
  async () => {
    const f = await projectDraftFixture();
    try {
      await f.project.drafts.put(autosaveCommand());
      const head = await f.snapshots.head(),
        draft = await f.project.drafts.get("doc-1");
      await expect(f.project.sourceEdits.apply(command(f.detail))).rejects.toThrow("workingCopyChanged");
      expect(await f.snapshots.head()).toBe(head);
      expect(await f.project.drafts.get("doc-1")).toEqual(draft);
      const { content: _discardContent, ...discard } = autosaveCommand("discard-1", 1);
      await f.project.drafts.discard(discard);
      for (const override of [
        { expectedVersion: 2 },
        { expectedContentHash: digest("wrong source") },
        { expectedRevisionId: "other-revision" },
      ])
        await expect(f.project.sourceEdits.apply({ ...command(f.detail), ...override })).rejects.toThrow("conflict");
      expect(await f.project.sourceEdits.receipt(command(f.detail))).toBeNull();
      expect(await f.snapshots.head()).toBe(head);
      await expect(
        f.project.sourceEdits.apply({
          ...command(f.detail),
          content: {
            ...command(f.detail).content,
            resources: [{ assetId: "missing-asset", digest: digest("missing"), source: "x", sourcePath: "x" }],
          },
        }),
      ).rejects.toThrow("invalidFile");
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "an unchanged autosave frame stays consumed after a source edit and later revisions",
  async () => {
    const f = await projectDraftFixture();
    try {
      await f.project.drafts.put({ ...autosaveCommand(), content: currentDraftContent(f.detail) });
      expect((await f.project.drafts.get("doc-1")).dirty).toBe(false);
      const applied = await f.project.sourceEdits.apply(command(f.detail));
      const reopened = new ProjectContentProject(f.owned);
      expect(await reopened.drafts.get("doc-1")).toMatchObject({
        dirty: false,
        stale: false,
        content: null,
        savedRevisionId: applied.detail.revision.id,
        version: 1,
      });
      const later = projectDocumentFixture(3, "doc-1", "Later content after source edit");
      await reopened.documents.put(later, 2, "later-content", draftAuthor);
      expect(await new ProjectContentProject(f.owned).drafts.get("doc-1")).toMatchObject({
        dirty: false,
        stale: false,
        content: null,
        savedRevisionId: later.revision.id,
      });
      const fresh = await reopened.drafts.put({
        ...autosaveCommand("new-draft", 1, later.revision.id),
        content: { ...currentDraftContent(later), content: "A real later draft" },
      });
      expect(fresh.version).toBe(2);
      expect((await reopened.drafts.get("doc-1")).dirty).toBe(true);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "the file application rechecks project ownership for receipt inspection as well as source edits",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const { author: _author, documentId: _documentId, ...input } = command(f.detail);
      expect(await f.application().changes.receipt("editor", "project-1", "doc-1", input)).toBeNull();
      const applied = await f.application().changes.apply("editor", "project-1", "doc-1", input);
      f.grants.clear();
      await expect(f.application().changes.receipt("editor", "project-1", "doc-1", input)).rejects.toBeInstanceOf(
        DocumentError,
      );
      await expect(f.application().changes.apply("editor", "project-1", "doc-1", input)).rejects.toMatchObject({
        status: 404,
      });
      f.grants.add("project-1");
      f.reopen();
      expect(await f.application().changes.receipt("editor", "project-1", "doc-1", input)).toEqual(applied);
      expect(await f.application().changes.apply("editor", "project-1", "doc-1", input)).toEqual(applied);
    } finally {
      await f.close();
    }
  },
  30000,
);
