import sharp from "sharp";
import { test, expect } from "bun:test";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Route } from "../../src/server/http/router.js";
import { PersonalContent } from "../../src/server/creative/personal.js";
import { personalCopyRoute } from "../../src/server/creative/copy.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

test("personal documents are isolated by authenticated owner; project copies are independent and retry-safe", async () => {
  const routes: Route[] = [],
    app = await projectFileApiFixture({ extraRoutes: routes });
  let owner = "alice";
  const personal = new PersonalContent({
    contentRoot: join(app.assetRoot, "content"),
    assetRoot: join(app.assetRoot, "assets"),
    stateRoot: join(app.assetRoot, "state"),
    owner: () => owner,
  });
  routes.push(personalCopyRoute({ personal, projects: app.application(), owner: () => owner }), ...personal.routes());
  try {
    const alice = await personal.forOwner(owner);
    const imageId = randomUUID(),
      imageBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#667788" } })
        .png()
        .toBuffer();
    const created = await alice.documents.navigation.createFromSource(
      owner,
      {
        id: randomUUID(),
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        title: "A personal article",
        locale: "en",
      },
      {
        identity: "copy-image-source",
        prepare: async () => ({
          body: richDocumentFromMarkdown(
            "```java\nclass Example {}\n```\n\nOriginal content.\n\n![Example](/api/document-assets/content?id=" +
              imageId +
              ")",
          ),
          images: [{ id: imageId, name: "example.png", bytes: imageBytes }],
        }),
      },
    );
    const id = created.operation.documentId,
      source = await alice.documents.queries.detail("personal", id);
    owner = "bob";
    const bobList = await app.call("/api/personal/project-document-tree?project=personal");
    expect(bobList.status).toBe(200);
    expect(bobList.body.nodes).toEqual([]);
    expect((await app.call(`/api/personal/project-documents/source?project=personal&id=${id}`)).status).toBe(404);
    owner = "alice";
    app.grants.add("project-2");
    const command = {
      operationId: randomUUID(),
      documentId: id,
      revisionId: source.revision.id,
      projects: ["project-1", "project-2", "denied"],
    };
    const copied = await app.call("/api/personal/copy", "POST", command);
    expect(copied.status).toBe(200);
    expect(copied.body.results.map((r: { state: string }) => r.state)).toEqual(["copied", "copied", "failed"]);
    const again = await app.call("/api/personal/copy", "POST", command);
    expect(again.body.results).toEqual(copied.body.results);
    for (const result of copied.body.results.filter((r: { state: string }) => r.state === "copied")) {
      const detail = await app.application().queries.detail(result.projectId, result.documentId);
      expect(detail.document.id).not.toBe(id);
      expect(detail.document.revision).toBe(1);
      expect(detail.revision.content).toContain("class Example {}");
      const log = Bun.spawn([
        "git",
        "-C",
        join(app.root, "projects", result.projectId),
        "log",
        "-1",
        "--format=%B",
        "refs/heads/content",
      ]);
      const message = await new Response(log.stdout).text();
      expect(await log.exited).toBe(0);
      expect(message).toContain("Panda-Copied-From: personal/" + id);
      expect(message).toContain("Panda-Copied-Revision: " + source.revision.id);
      const originalAssets = await alice.documents.assets.list("personal", id),
        copiedAssets = await app.application().assets.list(result.projectId, result.documentId);
      expect(copiedAssets).toHaveLength(1);
      expect(copiedAssets[0]!.id).not.toBe(originalAssets[0]!.id);
      expect((await app.application().assets.content(result.projectId, copiedAssets[0]!.id)).bytes).toEqual(imageBytes);
    }
    await alice.documents.navigation.rename(owner, {
      id: randomUUID(),
      projectId: "personal",
      treeVersion: created.tree.version,
      documentId: id,
      title: "Changed original",
      revision: source.document.revision,
    });
    const target = copied.body.results[0];
    expect((await app.application().queries.detail(target.projectId, target.documentId)).document.title).toBe(
      "A personal article",
    );
    expect((await alice.documents.queries.detail("personal", id)).document.title).toBe("Changed original");
    expect(
      (await app.call("/api/personal/copy", "POST", command, { origin: "https://untrusted.example" })).status,
    ).toBe(403);
  } finally {
    await personal.close();
    await app.close();
  }
}, 30000);
