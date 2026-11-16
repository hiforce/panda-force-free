import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectSpaceProfile } from "../support/project-space-fixture.js";

const spacesPath = "/api/project-document-spaces",
  detailPath = (id: string, project = "project-1") => spacesPath + "/detail?project=" + project + "&id=" + id,
  create = (projectId = "project-1", code = "site", engine = "hexo") => ({
    operationId: randomUUID(),
    projectId,
    code,
    name: "Publication",
    engine,
    sourceMode: "managed",
    locale: "en",
    theme: "default",
  });

test.concurrent(
  "publication spaces persist engine metadata separately from the authoring library without initializing on GET",
  async () => {
    const f = await projectFileApiFixture();
    f.grants.add("project-2");
    try {
      const before = await readdir(join(f.root, "projects"));
      expect((await f.call(spacesPath + "?project=project-2")).body.spaces).toEqual([]);
      expect(await readdir(join(f.root, "projects"))).toEqual(before);
      const command = create("project-2"),
        first = await f.call(spacesPath, "POST", command);
      expect(first.status).toBe(201);
      expect(first.body.space).toMatchObject({
        id: command.operationId,
        engine: "hexo",
        sourceMode: "managed",
        version: 1,
      });
      const owner = (await findOwnedProjectDirectory(f.root, "project-2"))!,
        snapshots = new ProjectGitSnapshots(owner),
        head = await snapshots.head();
      expect((await snapshots.entries(head)).map((row) => row.path)).toHaveLength(2);
      f.reopen();
      expect((await f.call(spacesPath, "POST", command)).body).toEqual(first.body);
      expect(await snapshots.head()).toBe(head);
      expect((await f.call(spacesPath, "POST", { ...command, operationId: randomUUID() })).status).toBe(409);
      expect(await snapshots.head()).toBe(head);
      const doc = await f.call("/api/project-document-tree/documents", "POST", {
        id: randomUUID(),
        projectId: "project-2",
        treeVersion: 0,
        title: "Document",
        locale: "en",
      });
      expect(doc.status).toBe(201);
      const docusaurus = await f.call(spacesPath, "POST", create("project-2", "handbook", "docusaurus"));
      expect(docusaurus.status).toBe(201);
      expect(
        (await f.call(spacesPath + "?project=project-2")).body.spaces
          .map((space: { engine: string }) => space.engine)
          .sort(),
      ).toEqual(["docusaurus", "hexo"]);
      expect((await f.call("/api/project-document-tree?project=project-2")).body.nodes).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "space configuration uses versions, preserves original retry receipts and rejects private or forged settings",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const created = await f.call(spacesPath, "POST", create()),
        id = created.body.space.id,
        profile = projectSpaceProfile(),
        command = { operationId: randomUUID(), version: 1, name: "Knowledge", profile },
        configured = await f.call(detailPath(id), "PUT", command);
      expect(configured.status).toBe(200);
      expect(configured.body).toMatchObject({ space: { id, name: "Knowledge", version: 2 }, profile });
      const results = await Promise.all([
        f.call(detailPath(id), "PUT", { operationId: randomUUID(), version: 2, name: "A" }),
        f.call(detailPath(id), "PUT", { operationId: randomUUID(), version: 2, name: "B" }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const current = (await f.call(detailPath(id))).body,
        head = await f.snapshots.head();
      expect(current.space.version).toBe(3);
      expect((await f.call(detailPath(id), "PUT", command)).body).toEqual(configured.body);
      expect(await f.snapshots.head()).toBe(head);
      expect(
        (await f.call(detailPath(id), "PUT", { operationId: randomUUID(), version: 3, name: current.space.name })).body,
      ).toEqual(current);
      expect(await f.snapshots.head()).toBe(head);
      const privateProfile = structuredClone(profile);
      privateProfile.editions.en!.config.theme_config = { api_key: "SHOULD-NOT-SAVE" };
      expect(
        (await f.call(detailPath(id), "PUT", { operationId: randomUUID(), version: 3, profile: privateProfile }))
          .status,
      ).toBe(400);
      const resources = structuredClone(profile);
      resources.resources = [{ directory: "assets", target: "assets", extensions: ["png"], publish: true }];
      expect(
        (await f.call(detailPath(id), "PUT", { operationId: randomUUID(), version: 3, profile: resources })).status,
      ).toBe(400);
      expect(
        (await f.call(detailPath(id), "PUT", { operationId: randomUUID(), version: 3, theme: "unknown@1.0.0" })).status,
      ).toBe(400);
      expect(
        (await f.call(detailPath(id), "PUT", { operationId: randomUUID(), version: 3, sourceRoot: "/outside" })).status,
      ).toBe(400);
      expect((await f.call(detailPath(id))).body).toEqual(current);
      expect(await f.snapshots.head()).toBe(head);
      expect(await readFile(join(f.owned.directory, "spaces", id + ".panda.json"), "utf8")).not.toContain(
        "SHOULD-NOT-SAVE",
      );
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "external space inspection respects allowed roots and saves metadata without modifying the source project",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "panda-external-space-")),
      f = await projectFileApiFixture({ allowedRoots: [root] });
    try {
      const pkg = '{"dependencies":{"hexo":"7.3.0"}}\n',
        article = "# Source article\n\nKeep unchanged.\n";
      await writeFile(join(root, "package.json"), pkg);
      await mkdir(join(root, "source"));
      await writeFile(join(root, "source", "article.md"), article);
      const inspect = spacesPath + "/inspect?project=project-1";
      expect((await f.call(inspect, "POST", { path: root })).body).toMatchObject({
        root,
        engine: "hexo",
        detectedVersion: "7.3.0",
      });
      expect((await f.call(inspect, "POST", { path: tmpdir() })).status).toBe(403);
      const input = { ...create(), sourceMode: "external", sourceRoot: root };
      expect((await f.call(spacesPath, "POST", { ...input, engine: "docusaurus" })).status).toBe(400);
      const saved = await f.call(spacesPath, "POST", input);
      expect(saved.status).toBe(201);
      expect(saved.body.space.sourceRoot).toBe(root);
      const profile = projectSpaceProfile();
      profile.resources = [{ directory: "assets", target: "assets", extensions: ["png"], publish: true }];
      expect(
        (await f.call(detailPath(saved.body.space.id), "PUT", { operationId: randomUUID(), version: 1, profile }))
          .status,
      ).toBe(200);
      expect(await readFile(join(root, "package.json"), "utf8")).toBe(pkg);
      expect(await readFile(join(root, "source", "article.md"), "utf8")).toBe(article);
      expect((await readdir(root)).sort()).toEqual(["package.json", "source"]);
      const head = await f.snapshots.head();
      await rm(join(root, "package.json"));
      f.reopen();
      expect((await f.call(spacesPath, "POST", input)).body).toEqual(saved.body);
      expect(await f.snapshots.head()).toBe(head);
      f.grants.delete("project-1");
      expect((await f.call(inspect, "POST", { path: root })).status).toBe(404);
      expect((await f.call(detailPath(saved.body.space.id))).status).toBe(404);
    } finally {
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

test.concurrent(
  "space endpoints reject unauthenticated, cross-origin, cross-project and unsupported configuration commands",
  async () => {
    const f = await projectFileApiFixture();
    try {
      const head = await f.snapshots.head();
      expect((await fetch(f.base + spacesPath + "?project=project-1")).status).toBe(401);
      expect((await f.call(spacesPath, "POST", create(), { origin: "https://untrusted.example" })).status).toBe(403);
      expect((await f.call(spacesPath, "POST", { ...create(), owner: "forged" })).status).toBe(400);
      expect((await f.call(spacesPath, "POST", { ...create(), sourceRoot: "/client-selected" })).status).toBe(400);
      expect((await f.call(spacesPath, "POST", create("forbidden"))).status).toBe(404);
      expect(await findOwnedProjectDirectory(f.root, "forbidden")).toBeNull();
      expect(await f.snapshots.head()).toBe(head);
      const saved = await f.call(spacesPath, "POST", create()),
        id = saved.body.space.id;
      f.grants.add("project-2");
      await f.call(spacesPath, "POST", create("project-2"));
      expect((await f.call(detailPath(id, "project-2"))).status).toBe(404);
      const docusaurus = await f.call(spacesPath, "POST", create("project-1", "docs", "docusaurus"));
      expect(
        (
          await f.call(detailPath(docusaurus.body.space.id), "PUT", {
            operationId: randomUUID(),
            version: 1,
            profile: projectSpaceProfile(),
          })
        ).status,
      ).toBe(400);
    } finally {
      await f.close();
    }
  },
  30000,
);
