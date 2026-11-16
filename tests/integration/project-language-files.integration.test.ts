import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";

const author = { name: "Language author", email: "language@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-language-files-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "project-1"),
      project = new ProjectContentProject(owned);
    await project.spaces.put(projectSpaceFixture("space-1", true), null, "library", "library", author);
    for (const [id, locale] of [
      ["en", "en"],
      ["zh", "zh-CN"],
      ["fr", "fr"],
      ["de", "de"],
      ["other-en", "EN"],
    ]) {
      const detail = projectDocumentFixture(1, id!);
      detail.document.locale = detail.revision.locale = locale!;
      await project.documents.put(detail, null, "create-" + id, author);
    }
    return {
      root,
      owned,
      project,
      snapshots: new ProjectGitSnapshots(owned),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
test.concurrent(
  "translation links merge identities, preserve source bytes and replay their original result after unlink",
  async () => {
    const f = await fixture();
    try {
      const source = await f.project.documents.get("en");
      const first = await f.project.languages.link("en", "zh", "link-en-zh", author);
      const second = await f.project.languages.link("fr", "de", "link-fr-de", author);
      expect(second.groups).toHaveLength(2);
      const merged = await f.project.languages.link("en", "fr", "merge", author);
      expect(merged.groups).toEqual([{ id: first.groups[0]!.id, documentIds: ["de", "en", "fr", "zh"] }]);
      const unlinked = await f.project.languages.unlink("en", "unlink-en", author);
      expect(unlinked.groups[0]!.documentIds).toEqual(["de", "fr", "zh"]);
      const reopened = new ProjectContentProject(f.owned);
      expect((await reopened.languages.list("en")).map((doc) => doc.id)).toEqual(["en"]);
      expect((await reopened.languages.list("zh")).map((doc) => doc.id)).toEqual(["de", "fr", "zh"]);
      expect(await reopened.languages.link("en", "zh", "link-en-zh", author)).toEqual(first);
      expect((await reopened.languages.list("en")).map((doc) => doc.id)).toEqual(["en"]);
      expect(await reopened.documents.get("en")).toEqual(source);
      await expect(reopened.languages.link("en", "fr", "link-en-zh", author)).rejects.toThrow("conflict");
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "concurrent language updates share one project lease and reject duplicate locales and cross-space membership",
  async () => {
    const f = await fixture();
    try {
      await Promise.all([
        f.project.languages.link("en", "zh", "link-zh", author),
        f.project.languages.link("en", "fr", "link-fr", author),
      ]);
      expect((await f.project.languages.list("en")).map((doc) => doc.id)).toEqual(["en", "fr", "zh"]);
      const head = await f.snapshots.head();
      await expect(f.project.languages.link("en", "other-en", "duplicate-locale", author)).rejects.toThrow("conflict");
      expect(await f.snapshots.head()).toBe(head);
      await f.project.spaces.put(projectSpaceFixture("other-space"), null, "publication", "other-space", author);
      const foreign = projectDocumentFixture(1, "other-space-doc");
      foreign.document.spaceId = "other-space";
      foreign.document.locale = foreign.revision.locale = "ja";
      await f.project.documents.put(foreign, null, "foreign-document", author);
      const after = await f.snapshots.head();
      await expect(f.project.languages.link("en", foreign.document.id, "cross-space", author)).rejects.toThrow(
        "invalidFile",
      );
      expect(await f.snapshots.head()).toBe(after);
    } finally {
      await f.close();
    }
  },
  30000,
);
