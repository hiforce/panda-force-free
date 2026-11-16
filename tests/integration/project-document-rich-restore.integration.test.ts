import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { documentContentIdentity } from "../../src/shared/documents/content-identity.js";
import { emptyRichBody } from "../../src/shared/documents/rich-body.js";
import { projectGit } from "../../src/server/project-content/git/process.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectDraftFixture, checkpointCommand, draftAuthor } from "../support/project-draft-fixture.js";

test("rich history restoration retains the original Markdown projection and registered image mapping verbatim", async () => {
  const initial = projectDocumentFixture(),
    body = emptyRichBody(),
    assetId = "33333333-3333-4333-8333-333333333333";
  body.document.content = [
    { type: "paragraph", content: [{ type: "text", text: "Original rich source", marks: [{ type: "bold" }] }] },
    {
      type: "image",
      attrs: {
        src: "/api/document-assets/content?id=" + assetId,
        alt: "Original image",
        title: "",
        width: 1,
        height: 1,
      },
    },
  ];
  initial.revision.body = body;
  initial.revision.content = "A historical exact projection\r\n\n";
  initial.revision.resources = [
    { source: "images/original.png", sourcePath: "images/original.png", assetId, digest: "a".repeat(64) },
  ];
  initial.document.contentHash = initial.revision.contentHash = createHash("sha256")
    .update(documentContentIdentity(initial.revision.content, body))
    .digest("hex");
  const f = await projectDraftFixture(initial);
  try {
    await f.project.assets.put(
      {
        id: assetId,
        documentId: "doc-1",
        name: "original.png",
        mime: "image/png",
        digest: "a".repeat(64),
        size: 100,
        width: 1,
        height: 1,
        alt: "Original image",
        createdAt: 100,
      },
      "asset",
      draftAuthor,
    );
    const second = projectDocumentFixture(2);
    await f.project.documents.put(second, 1, "later-plain-version", draftAuthor);
    const restored = await f.project.checkpoints.restore({
      ...checkpointCommand("restore-rich", 0, second.revision.id),
      revisionId: initial.revision.id,
    });
    expect(restored.detail.revision.body).toEqual(body);
    expect(restored.detail.revision.content).toBe(initial.revision.content);
    expect(restored.detail.revision.resources).toEqual(initial.revision.resources);
    expect(restored.detail.revision.contentHash).toBe(initial.revision.contentHash);
    expect(restored.detail.document.revision).toBe(3);
    expect((await f.project.documents.revision("doc-1", second.revision.id)).content).toBe(second.revision.content);
    expect((await f.project.drafts.get("doc-1")).version).toBe(0);
    const message = (await projectGit(f.owned.directory, ["log", "-1", "--format=%B", restored.commit])).toString();
    expect(message).toContain("Panda-Checkpoint: restore");
    expect(message).toContain("Panda-Source-Revision: " + initial.revision.id);
  } finally {
    await f.close();
  }
}, 30000);
