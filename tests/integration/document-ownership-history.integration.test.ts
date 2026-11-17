import { expect, test } from "bun:test";
import { ProjectDocumentFiles } from "../../src/server/project-content/document-store.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { decodeProjectDocument } from "../../src/server/project-content/document-file.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { projectDraftFixture, draftAuthor } from "../support/project-draft-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";

test("ownership history paging reads every original at a pinned commit and excludes later edits", async () => {
  const f = await projectDraftFixture();
  try {
    for (let n = 2; n <= 7; n++)
      await f.project.documents.put(
        projectDocumentFixture(n, "doc-1", "Original " + n),
        n - 1,
        "version-" + n,
        draftAuthor,
      );
    const first = await f.project.documents.revisionPage("doc-1", 2),
      snapshot = new ProjectGitSnapshots(f.owned),
      versions = [...first.revisions];
    expect(first.revisions.map((row) => row.revision.number)).toEqual([7, 6]);
    await f.project.documents.put(projectDocumentFixture(8, "doc-1", "Later user edit"), 7, "later-edit", draftAuthor);
    let cursor = first.nextCommit;
    const reopened = new ProjectDocumentFiles(f.owned);
    while (cursor) {
      const page = await reopened.revisionPage("doc-1", 2, cursor);
      versions.push(...page.revisions);
      cursor = page.nextCommit;
    }
    expect(versions.map((row) => row.revision.number)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(new Set(versions.map((row) => row.revision.id)).size).toBe(7);
    for (const row of versions) {
      const bytes = await snapshot.fileAt(row.commit, projectDocumentFile("doc-1"));
      const detail = decodeProjectDocument(bytes!);
      expect(detail.revision.id).toBe(row.revision.id);
      expect(detail.revision.number).toBe(row.revision.number);
      expect(detail.revision.content).toBe(
        row.revision.number === 1 ? f.detail.revision.content : "Original " + row.revision.number,
      );
    }
    expect((await reopened.get("doc-1")).document.revision).toBe(8);
    await expect(reopened.revisionPage("doc-1", 1001)).rejects.toThrow("invalidFile");
    await expect(reopened.revisionPage("missing", 1)).rejects.toThrow("notFound");
  } finally {
    await f.close();
  }
}, 60000);
