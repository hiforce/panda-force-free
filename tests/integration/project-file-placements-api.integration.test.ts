import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

const projectId = "project-1",
  base = "/api/project-document-placements",
  scope = "project=" + projectId;
async function target(f: Awaited<ReturnType<typeof projectFileApiFixture>>) {
  const result = await f.call("/api/project-document-spaces", "POST", {
    operationId: randomUUID(),
    projectId,
    code: "website",
    name: "Website",
    engine: "hexo",
    sourceMode: "managed",
    locale: "en",
    theme: "default",
  });
  expect(result.status).toBe(201);
  return result.body.space;
}
const create = (spaceId: string) => ({
  id: randomUUID(),
  operationId: randomUUID(),
  documentId: "doc-1",
  spaceId,
  spaceVersion: 1,
  path: "posts/article.md",
  locale: "en",
  revisionId: null,
  metadata: { title: "Publication title" },
});

test.concurrent(
  "file placement HTTP commands preserve originals, destination versions and immutable retry history across restart",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const space = await target(f),
        command = create(space.id),
        first = await f.call(base + "?" + scope, "POST", command);
      expect(first.status).toBe(201);
      expect(first.body.placement).toMatchObject({ id: command.id, version: 1, documentId: "doc-1" });
      expect(
        (await f.call("/api/project-document-spaces/detail?" + scope + "&id=" + space.id)).body.space.version,
      ).toBe(2);
      const secondCommand = {
        operationId: randomUUID(),
        version: 1,
        spaceVersion: 2,
        path: "posts/edited.md",
        locale: "en",
        revisionId: f.detail.revision.id,
        metadata: { title: "Edited destination" },
      };
      const second = await f.call(base + "/detail?" + scope + "&id=" + command.id, "PUT", secondCommand);
      expect(second.status).toBe(200);
      expect(second.body.placement).toMatchObject({ version: 2, path: "posts/edited.md" });
      f.reopen();
      expect((await f.call(base + "?" + scope, "POST", command)).body).toEqual(first.body);
      const removedCommand = { operationId: randomUUID(), version: 2, spaceVersion: 3 },
        removed = await f.call(base + "/detail?" + scope + "&id=" + command.id, "DELETE", removedCommand);
      expect(removed.status).toBe(200);
      expect(removed.body.placement.deletedAt).toBeGreaterThan(0);
      expect((await f.call(base + "/detail?" + scope + "&id=" + command.id, "PUT", secondCommand)).body).toEqual(
        second.body,
      );
      expect((await f.call(base + "/detail?" + scope + "&id=" + command.id, "DELETE", removedCommand)).body).toEqual(
        removed.body,
      );
      expect((await f.call(base + "?" + scope + "&document=doc-1")).body.placements).toEqual([]);
      const history = await f.call(base + "/history?" + scope + "&id=" + command.id);
      expect(history.status).toBe(200);
      expect(history.body.events.map((row: { audit: { operation: string } }) => row.audit.operation)).toEqual([
        "remove",
        "update",
        "create",
      ]);
      expect(history.body.events[0].placement).not.toHaveProperty("metadata");
      const selected = await f.call(base + "/history?" + scope + "&id=" + command.id + "&version=1");
      expect(selected.status).toBe(200);
      expect(selected.body.event.placement).toEqual(first.body.placement);
      expect(selected.body.event.operation).toBe("create");
      expect((await f.call(base + "/history?" + scope + "&id=" + command.id + "&version=0")).status).toBe(400);
      expect((await f.call(base + "/history?" + scope + "&id=" + command.id + "&version=99")).status).toBe(404);
      expect((await f.call("/api/project-documents/source?" + scope + "&id=doc-1")).body.revision).toEqual(
        f.detail.revision,
      );
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file placement policy rejects stale targets, duplicate paths and locale mismatches without a partial commit",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const space = await target(f),
        command = create(space.id);
      expect((await f.call(base + "?" + scope, "POST", { ...command, spaceVersion: 2 })).status).toBe(409);
      expect((await f.call(base + "?" + scope, "POST", { ...command, locale: "zh-CN" })).status).toBe(409);
      expect(
        (await f.call(base + "?" + scope, "POST", { ...command, metadata: { secret: "never public" } })).status,
      ).toBe(400);
      expect((await f.call(base + "?" + scope + "&space=" + space.id)).body.placements).toEqual([]);
      expect(
        (await f.call("/api/project-document-spaces/detail?" + scope + "&id=" + space.id)).body.space.version,
      ).toBe(1);
      expect((await f.call(base + "?" + scope, "POST", command)).status).toBe(201);
      const duplicate = await f.call(base + "?" + scope, "POST", {
        ...command,
        id: randomUUID(),
        operationId: randomUUID(),
        spaceVersion: 2,
        path: "POSTS/ARTICLE.md",
      });
      expect(duplicate.status).toBe(409);
      const forbiddenLibrary = await f.call(base + "?" + scope, "POST", {
        ...command,
        id: randomUUID(),
        operationId: randomUUID(),
        spaceId: "space-1",
      });
      expect(forbiddenLibrary.status).toBe(400);
      expect((await f.call(base + "?" + scope + "&space=" + space.id)).body.placements).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file link removal remains possible after source trash and immutable creation retries survive changed policies",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const space = await target(f),
        command = create(space.id),
        first = await f.call(base + "?" + scope, "POST", command);
      const configuration = await f.call("/api/project-document-spaces/detail?" + scope + "&id=" + space.id, "PUT", {
        operationId: randomUUID(),
        version: 2,
        name: "Renamed website",
      });
      expect(configuration.status).toBe(200);
      expect((await f.call(base + "?" + scope, "POST", command)).body).toEqual(first.body);
      f.actor("operator:another-user");
      expect((await f.call(base + "?" + scope, "POST", command)).status).toBe(409);
      f.actor("operator:test-user");
      f.grants.delete(projectId);
      expect((await f.call(base + "/detail?" + scope + "&id=" + command.id)).status).toBe(404);
      f.grants.add(projectId);
      await f.project.navigation.put(
        {
          spaceId: "space-1",
          version: 0,
          nodes: [],
          trash: [{ documentId: "doc-1", parentId: null, position: null, deletedAt: Date.now(), operationId: null }],
          origins: [],
          lastOperation: null,
        },
        null,
        "trash-fixture",
        { name: "Test", email: "test@example.test" },
      );
      const removal = await f.call(base + "/detail?" + scope + "&id=" + command.id, "DELETE", {
        operationId: randomUUID(),
        version: 1,
        spaceVersion: 3,
      });
      expect(removal.status).toBe(200);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file publication links enforce the authenticated project and origin before mutations",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const space = await target(f),
        command = create(space.id);
      expect((await f.call(base + "?" + scope, "POST", command, { authorization: "invalid" })).status).toBe(401);
      expect((await f.call(base + "?" + scope, "POST", command, { origin: "https://foreign.example" })).status).toBe(
        403,
      );
      expect((await f.call(base + "?project=foreign", "POST", command)).status).toBe(404);
      expect((await f.call(base + "?" + scope + "&document=doc-1&space=" + space.id)).status).toBe(400);
      expect((await f.call(base + "?" + scope, "POST", { ...command, revisionId: "missing" })).status).toBe(404);
      expect((await f.call(base + "?" + scope + "&space=" + space.id)).body.placements).toEqual([]);
    } finally {
      await f.close();
    }
  },
  30000,
);
