import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectSpaceFixture, projectSpaceProfile } from "../support/project-space-fixture.js";

const author = { name: "Space author", email: "space@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-space-files-")),
    owned = await createOwnedProjectDirectory(root, "project-1");
  return {
    root,
    owned,
    project: new ProjectContentProject(owned),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("file spaces and the project library commit membership atomically and survive a fresh composition", async () => {
  const f = await fixture();
  try {
    expect(await f.project.spaces.list()).toEqual([]);
    expect(await f.project.spaces.library()).toBeNull();
    const library = projectSpaceFixture("library", true),
      site = projectSpaceFixture();
    site.space.sourceMode = "external";
    site.space.sourceRoot = "/example/read-only-source";
    site.sourceProfile = projectSpaceProfile();
    const [a, b] = await Promise.all([
      f.project.spaces.put(library, null, "library", "create-library", author),
      f.project.spaces.put(site, null, "publication", "create-site", author),
    ]);
    expect(a).toEqual(library);
    expect(b).toEqual(site);
    const reopened = new ProjectContentProject(f.owned);
    expect(await reopened.spaces.library()).toEqual(library.space);
    expect(await reopened.spaces.list()).toEqual([site.space]);
    expect(await reopened.spaces.get(site.space.id)).toEqual(site);
    expect(JSON.parse(await readFile(join(f.owned.directory, "project.json"), "utf8"))).toMatchObject({
      librarySpaceId: "library",
      spaceIds: ["library", "space-1"],
      version: 2,
    });
    const next = structuredClone(site);
    next.space.name = "Updated site";
    next.space.version++;
    next.space.updatedAt++;
    await reopened.spaces.put(next, 1, "publication", "rename-site", author);
    expect(await reopened.spaces.put(site, null, "publication", "create-site", author)).toEqual(site);
    expect(await reopened.spaces.get(site.space.id)).toEqual(next);
    await expect(reopened.spaces.put(next, 1, "publication", "stale-site", author)).rejects.toThrow("conflict");
  } finally {
    await f.close();
  }
}, 30000);

test("queued uniqueness and role checks prevent duplicate codes, multiple libraries and immutable binding changes", async () => {
  const f = await fixture();
  try {
    const one = projectSpaceFixture(),
      two = projectSpaceFixture("space-2");
    two.space.code = one.space.code.toUpperCase();
    const result = await Promise.allSettled([
      f.project.spaces.put(one, null, "publication", "one", author),
      f.project.spaces.put(two, null, "publication", "two", author),
    ]);
    expect(result.map((value) => value.status)).toEqual(["fulfilled", "rejected"]);
    const library = projectSpaceFixture("library", true);
    await f.project.spaces.put(library, null, "library", "library", author);
    await expect(
      f.project.spaces.put(projectSpaceFixture("second-library", true), null, "library", "other-library", author),
    ).rejects.toThrow("conflict");
    const changed = structuredClone(one);
    changed.space.version = 2;
    changed.space.sourceRoot = "/must-not-move";
    await expect(f.project.spaces.put(changed, 1, "publication", "move-source", author)).rejects.toThrow("conflict");
    const foreign = projectSpaceFixture("foreign");
    foreign.space.projectId = "other-project";
    await expect(f.project.spaces.put(foreign, null, "publication", "foreign", author)).rejects.toThrow("invalidFile");
    expect((await f.project.spaces.list()).map((space) => space.id)).toEqual(["space-1"]);
    expect(await f.project.spaces.library()).toEqual(library.space);
  } finally {
    await f.close();
  }
}, 30000);

test("space lists parse metadata while full opens detect corrupted profile bytes and preserve the original Git snapshot", async () => {
  const f = await fixture();
  try {
    const site = projectSpaceFixture();
    site.sourceProfile = projectSpaceProfile(true);
    await f.project.spaces.put(site, null, "publication", "site", author);
    const path = join(f.owned.directory, "spaces", "space-1.panda.json"),
      original = await readFile(path, "utf8");
    await writeFile(path, original.replace('"sourceProfile": {', '"sourceProfile": INVALID {'));
    expect(await f.project.spaces.list()).toEqual([site.space]);
    await expect(f.project.spaces.get("space-1")).rejects.toThrow("conflict");
    const snapshots = new ProjectGitSnapshots(f.owned);
    expect((await snapshots.fileAt(await snapshots.head(), "spaces/space-1.panda.json"))?.toString()).toBe(original);
    await writeFile(path, original);
    await f.project.coordinator.mutate({
      operationId: "invalid-root",
      author,
      message: "Prepare broken index fixture",
      changes: [
        {
          path: "project.json",
          content: JSON.stringify({
            schema: 1,
            projectId: "project-1",
            version: 2,
            librarySpaceId: null,
            spaceIds: [],
          }),
        },
      ],
    });
    const before = await snapshots.head();
    await expect(
      f.project.spaces.put(projectSpaceFixture("new-space"), null, "publication", "new-space", author),
    ).rejects.toThrow("conflict");
    expect(await snapshots.head()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);
