import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceProfile } from "../support/project-space-fixture.js";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";

const author = { name: "Source test", email: "source@example.test" },
  projectId = "project-1",
  limits = { documents: 500, bytes: 16 * 1024 * 1024 };
async function setup() {
  const f = await projectFileApiFixture();
  const space = await f.application().spaces.create("test:source", {
    operationId: randomUUID(),
    projectId,
    code: "publication",
    name: "Publication",
    engine: "hexo",
    sourceMode: "managed",
    locale: "en",
    theme: "default",
  });
  return {
    f,
    space,
    async link(revisionId: string | null = null, path = "article.md") {
      return f.application().placements.create("test:source", projectId, {
        operationId: randomUUID(),
        id: randomUUID(),
        documentId: "doc-1",
        spaceId: space.id,
        spaceVersion: (await f.application().spaces.get(projectId, space.id)).space.version,
        path,
        locale: "en",
        revisionId,
        metadata: { title: "Target title" },
      });
    },
  };
}
test.concurrent(
  "file build capture pins the saved source and destination while ignoring live working drafts",
  async () => {
    const { f, space, link } = await setup();
    try {
      const placement = await link(),
        original = f.detail.revision;
      await f.application().editor.autosave("test:source", projectId, "doc-1", {
        operationId: randomUUID(),
        version: 0,
        baseRevisionId: original.id,
        working: { title: "Not saved", locale: "en", content: "Working-only content", resources: [] },
      });
      const snapshot = await f.application().snapshots.capture(projectId, space.id, "en", limits, 2);
      expect(snapshot.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(snapshot.documents).toHaveLength(1);
      expect(snapshot.documents[0]).toMatchObject({
        revision: original,
        path: "article.md",
        metadata: { title: "Target title" },
        placement: { id: placement.id, version: 1 },
      });
      expect(snapshot.documents[0]!.revision.content).not.toContain("Working-only");
      const next = projectDocumentFixture(2);
      await f.project.documents.put(next, 1, "second-source", author);
      const fresh = await f.application().snapshots.capture(projectId, space.id, "en", limits);
      expect(fresh.documents[0]!.revision.id).toBe(next.revision.id);
      expect(snapshot.documents[0]!.revision.id).toBe(original.id);
      expect(snapshot.commit).not.toBe(fresh.commit);
    } finally {
      await f.close();
    }
  },
  30000,
);
test.concurrent(
  "pinned file publication links retain exact historical originals and are independent from current source versions",
  async () => {
    const { f, space, link } = await setup();
    try {
      const placement = await link(f.detail.revision.id);
      await f.project.documents.put(projectDocumentFixture(2, "doc-1", "Later body\n"), 1, "second", author);
      f.reopen();
      const snapshot = await f.application().snapshots.capture(projectId, space.id, "en", limits);
      expect(snapshot.documents[0]!.revision).toEqual(f.detail.revision);
      expect(snapshot.documents[0]!.document.revision).toBe(2);
      expect(snapshot.documents[0]!.placement?.id).toBe(placement.id);
      expect((await f.application().queries.detail(projectId, "doc-1")).revision.content).toBe("Later body\n");
    } finally {
      await f.close();
    }
  },
  30000,
);
test.concurrent(
  "file snapshot validates complete originals, target policies, scope and budgets before returning content",
  async () => {
    const { f, space, link } = await setup();
    try {
      await link();
      await expect(
        f.application().snapshots.capture(projectId, space.id, "en", { documents: 1, bytes: 2 }),
      ).rejects.toMatchObject({ code: "tooLarge", status: 413 });
      await expect(f.application().snapshots.capture(projectId, space.id, "en", limits, 1)).rejects.toMatchObject({
        code: "spaceConflict",
        status: 409,
      });
      await expect(f.application().snapshots.capture(projectId, "space-1", "en", limits)).rejects.toMatchObject({
        code: "invalidPlacementTarget",
      });
      const sourcePath = join(f.owned.directory, projectDocumentFile("doc-1"));
      await writeFile(
        sourcePath,
        (await f.project.coordinator.read([projectDocumentFile("doc-1")])).files
          .get(projectDocumentFile("doc-1"))!
          .toString()
          .replace("Exact source", "Other source"),
      );
      await expect(f.application().snapshots.capture(projectId, space.id, "en", limits)).rejects.toMatchObject({
        code: "conflict",
        status: 409,
      });
      f.grants.delete(projectId);
      await expect(f.application().snapshots.capture(projectId, space.id, "en", limits)).rejects.toMatchObject({
        code: "notFound",
        status: 404,
      });
    } finally {
      await f.close();
    }
  },
  30000,
);
test.concurrent(
  "historical source reads enforce a caller byte bound and reject a forged immutable summary",
  async () => {
    const { f, space, link } = await setup();
    try {
      await link(f.detail.revision.id);
      await f.project.documents.put(projectDocumentFixture(2), 1, "second", author);
      await expect(f.snapshots.fileAt(await f.snapshots.head(), projectDocumentFile("doc-1"), 4)).rejects.toMatchObject(
        { code: "tooLarge" },
      );
      const original = projectDocumentFixture(3, "doc-1", "A valid saved source");
      const { revisionCommitMessage } = await import("../../src/server/project-content/document-history.js"),
        { encodeProjectDocument } = await import("../../src/server/project-content/document-file.js");
      const forged = {
        id: original.revision.id,
        documentId: original.document.id,
        number: 3,
        title: "Forged summary",
        locale: "en",
        contentHash: createHash("sha256").update("mismatch").digest("hex"),
        createdAt: original.revision.createdAt,
      };
      const message = revisionCommitMessage(original.revision).replace(
        /^Panda-Revision-Metadata: .+$/m,
        "Panda-Revision-Metadata: " + Buffer.from(JSON.stringify(forged)).toString("base64url"),
      );
      await f.project.coordinator.mutate({
        operationId: "forged",
        author,
        message,
        changes: [{ path: projectDocumentFile("doc-1"), content: encodeProjectDocument(original) }],
      });
      const current = (await f.application().spaces.get(projectId, space.id)).space;
      const record = (await f.application().placements.list(projectId, "spaceId", space.id))[0]!;
      await f.application().placements.update("test:source", projectId, record.id, {
        operationId: randomUUID(),
        version: record.version,
        spaceVersion: current.version,
        path: record.path,
        locale: "en",
        revisionId: original.revision.id,
        metadata: {},
      });
      await f.project.documents.put(projectDocumentFixture(4), 3, "fourth", author);
      await expect(f.application().snapshots.capture(projectId, space.id, "en", limits)).rejects.toMatchObject({
        code: "unavailable",
        status: 503,
      });
    } finally {
      await f.close();
    }
  },
  30000,
);
test.concurrent(
  "frozen publication metadata follows the destination public profile and rejects removed custom fields",
  async () => {
    const { f, space, link } = await setup();
    try {
      const profile = projectSpaceProfile();
      profile.metadataFields = ["custom_label"];
      await f
        .application()
        .spaces.configure("test:source", projectId, space.id, { operationId: randomUUID(), version: 1, profile });
      const placement = await f.application().placements.create("test:source", projectId, {
        operationId: randomUUID(),
        id: randomUUID(),
        documentId: "doc-1",
        spaceId: space.id,
        spaceVersion: 2,
        path: "article.md",
        locale: "en",
        metadata: { custom_label: "Public value" },
      });
      const snapshot = await f.application().snapshots.capture(projectId, space.id, "en", limits);
      expect(snapshot.profile).toEqual(profile);
      expect(snapshot.documents[0]!.metadata).toEqual({ custom_label: "Public value" });
      const removed = { ...profile, metadataFields: [] };
      await f.application().spaces.configure("test:source", projectId, space.id, {
        operationId: randomUUID(),
        version: 3,
        profile: removed,
      });
      await expect(f.application().snapshots.capture(projectId, space.id, "en", limits)).rejects.toMatchObject({
        code: "invalidPlacementMetadata",
      });
      expect((await f.application().placements.get(projectId, placement.id)).metadata).toEqual({
        custom_label: "Public value",
      });
      void link;
    } finally {
      await f.close();
    }
  },
  30000,
);
