import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import { FileDocumentSourceProfiles } from "../../src/server/documents/files/spaces/profiles.js";
import { DocumentSourceReader } from "../../src/server/documents/source-reader.js";
import { DocumentError } from "../../src/server/documents/errors.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-file-profile-source-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { hexo: "1.0.0" } }));
  await writeFile(join(root, "assets/style.css"), "body { color: #222; }");
  const config =
    "title: Source site\nurl: https://source.example\nroot: /blog/\ndescription: Public description\ndeploy:\n  token: never-public-token\n";
  await writeFile(join(root, "_config.yml"), config);
  const f = await projectFileApiFixture({ allowedRoots: [root] }),
    space = await f.application().spaces.create("test:profile", {
      operationId: randomUUID(),
      projectId: "project-1",
      code: "source",
      name: "Source",
      engine: "hexo",
      sourceMode: "external",
      sourceRoot: root,
      locale: "en",
      theme: "default",
    });
  return {
    f,
    root,
    space,
    config,
    async close() {
      await f.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test.concurrent(
  "file source profile HTTP inspection strips private configuration and captures only administrator-approved resources",
  async () => {
    const { f, root, space, config, close } = await fixture();
    try {
      const scope = "?project=project-1&id=" + space.id,
        prefix = "/api/project-document-spaces/source-profile";
      const options = await f.call(prefix + "/options" + scope);
      expect(options.status).toBe(200);
      expect(options.body.files).toContain("_config.yml");
      const proposal = await f.call(prefix + "/inspect" + scope, "POST", {
        locale: "en",
        files: ["_config.yml"],
        webp: false,
      });
      expect(proposal.status).toBe(200);
      expect(proposal.body.profile.editions.en.title).toBe("Source site");
      expect(JSON.stringify(proposal.body)).not.toContain("never-public-token");
      expect((await f.application().spaces.get("project-1", space.id)).space.version).toBe(1);
      await f.application().spaces.configure("test:profile", "project-1", space.id, {
        operationId: randomUUID(),
        version: 1,
        profile: proposal.body.profile,
      });
      f.reopen();
      const captured = await f.application().profiles.capture("project-1", space.id, "EN", 2);
      expect(captured?.edition.title).toBe("Source site");
      expect(captured?.files.map((file) => file.path)).toEqual(["assets/style.css"]);
      expect(captured?.spaceVersion).toBe(2);
      expect(captured?.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(await readFile(join(root, "_config.yml"), "utf8")).toBe(config);
      expect(await readFile(join(root, "assets/style.css"), "utf8")).toBe("body { color: #222; }");
    } finally {
      await close();
    }
  },
  30000,
);
test.concurrent(
  "file profile capture rejects settings changes or authorization revocation during asynchronous external reads",
  async () => {
    const { f, root, space, close } = await fixture();
    try {
      const proposal = await f.application().profiles.inspect("project-1", space.id, "en", ["_config.yml"], false);
      await f.application().spaces.configure("test:profile", "project-1", space.id, {
        operationId: randomUUID(),
        version: 1,
        profile: proposal.profile,
      });
      const projects = new DocumentFileProjects(f.root, (id) => {
          if (!f.grants.has(id)) throw new DocumentError("notFound", 404);
        }),
        reader = new DocumentSourceReader([root]);
      const changed = new FileDocumentSourceProfiles(projects, {
        root: async (path) => {
          const result = await reader.root(path);
          await f.application().spaces.configure("test:profile", "project-1", space.id, {
            operationId: randomUUID(),
            version: 2,
            name: "New settings",
          });
          return result;
        },
      });
      await expect(changed.capture("project-1", space.id, "en", 2)).rejects.toMatchObject({
        code: "spaceConflict",
        status: 409,
      });
      const revoked = new FileDocumentSourceProfiles(projects, {
        root: async (path) => {
          const result = await reader.root(path);
          f.grants.delete("project-1");
          return result;
        },
      });
      await expect(revoked.capture("project-1", space.id, "en", 3)).rejects.toMatchObject({
        code: "notFound",
        status: 404,
      });
    } finally {
      await close();
    }
  },
  30000,
);
test.concurrent(
  "file source inspection keeps route scope and does not allow symlink resource escape",
  async () => {
    const { f, root, space, close } = await fixture();
    try {
      const prefix = "/api/project-document-spaces/source-profile",
        scope = "?project=project-1&id=" + space.id;
      expect((await f.call(prefix + "/options" + scope, "GET", undefined, { authorization: "invalid" })).status).toBe(
        401,
      );
      expect(
        (
          await f.call(
            prefix + "/inspect" + scope,
            "POST",
            { locale: "en", files: ["_config.yml"], webp: false },
            { origin: "https://foreign.example" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.call(prefix + "/inspect?project=foreign&id=" + space.id, "POST", {
            locale: "en",
            files: ["_config.yml"],
            webp: false,
          })
        ).status,
      ).toBe(404);
      expect(
        (await f.call(prefix + "/inspect" + scope, "POST", { locale: "en", files: ["../secret.yml"], webp: false }))
          .status,
      ).toBe(400);
      const proposal = await f.application().profiles.inspect("project-1", space.id, "en", ["_config.yml"], false);
      await f.application().spaces.configure("test:profile", "project-1", space.id, {
        operationId: randomUUID(),
        version: 1,
        profile: proposal.profile,
      });
      await symlink(join(root, "_config.yml"), join(root, "assets/private.css"));
      await expect(f.application().profiles.capture("project-1", space.id, "en", 2)).rejects.toMatchObject({
        code: "sourceUnavailable",
      });
      expect(JSON.stringify((await f.application().spaces.get("project-1", space.id)).profile)).not.toContain(
        "never-public-token",
      );
    } finally {
      await close();
    }
  },
  30000,
);
