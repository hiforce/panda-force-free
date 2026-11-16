import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { DocumentAsset } from "../../src/shared/documents/contracts.js";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { openProjectAssetDirectory } from "../../src/server/project-content/asset-directory.js";
import { ProjectAssetBlobs } from "../../src/server/project-content/asset-blobs.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectGit } from "../../src/server/project-content/git/process.js";
import { projectAssetShard } from "../../src/server/project-content/asset-file.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";

const author = { name: "Asset author", email: "asset@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-asset-files-")),
    content = await createOwnedProjectDirectory(root, "project-1"),
    project = new ProjectContentProject(content),
    assetRoot = join(root, "assets");
  try {
    await mkdir(assetRoot);
    const owned = await openProjectAssetDirectory(assetRoot, content),
      blobs = new ProjectAssetBlobs(owned);
    await project.spaces.put(projectSpaceFixture("space-1", true), null, "library", "library", author);
    await project.documents.put(projectDocumentFixture(), null, "document", author);
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
        .png()
        .toBuffer(),
      digest = createHash("sha256").update(bytes).digest("hex");
    const asset: DocumentAsset = {
      id: "asset-1",
      documentId: "doc-1",
      name: "original 文件.png",
      mime: "image/png",
      digest,
      size: bytes.length,
      width: 2,
      height: 2,
      alt: "Original image",
      createdAt: 100,
    };
    return {
      root,
      content,
      project,
      assetRoot,
      owned,
      blobs,
      bytes,
      asset,
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
test.concurrent(
  "binary assets remain outside Git while original names and ownership survive restart and legacy copy",
  async () => {
    const f = await fixture();
    try {
      await Promise.all([f.blobs.put(f.asset.digest, f.bytes), f.blobs.put(f.asset.digest, f.bytes)]);
      await f.project.assets.put(f.asset, "asset-register", author);
      const source = join(f.root, "legacy-blobs");
      await mkdir(source);
      await writeFile(join(source, f.asset.digest), f.bytes);
      await f.blobs.copyLegacy(source, f.asset);
      const reopened = new ProjectContentProject(f.content),
        blobs = new ProjectAssetBlobs(await openProjectAssetDirectory(f.assetRoot, f.content));
      expect(await reopened.assets.get(f.asset.id)).toEqual(f.asset);
      expect(await reopened.assets.list("doc-1")).toEqual([f.asset]);
      expect(await blobs.read(f.asset.digest, f.asset.size)).toEqual(f.bytes);
      expect(await readFile(join(source, f.asset.digest))).toEqual(f.bytes);
      const snapshots = new ProjectGitSnapshots(f.content),
        objects = (
          await projectGit(f.content.directory, [
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname) %(objecttype)",
          ])
        )
          .toString()
          .trim()
          .split("\n");
      for (const row of objects.filter((row) => row.endsWith(" blob")))
        expect((await snapshots.content(row.split(" ")[0]!)).includes(f.bytes)).toBe(false);
      expect((await snapshots.entries(await snapshots.head())).some((row) => row.path.includes(f.asset.digest))).toBe(
        false,
      );
      await expect(reopened.assets.put({ ...f.asset, name: "changed.png" }, "changed-name", author)).rejects.toThrow(
        "conflict",
      );
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "one asset plan merges same-shard records and rejects foreign parents without partial changes",
  async () => {
    const f = await fixture();
    try {
      let other = "";
      for (let n = 2; n < 10000; n++)
        if (projectAssetShard("asset-" + n) === projectAssetShard(f.asset.id)) {
          other = "asset-" + n;
          break;
        }
      expect(other).not.toBe("");
      const second = { ...f.asset, id: other, name: "another original.png" },
        before = await new ProjectGitSnapshots(f.content).head();
      await f.project.coordinator.transact(
        { operationId: "asset-batch", author, message: "Register staged images", intent: "asset-batch-v1" },
        (view) => f.project.assets.prepareMany(view, [f.asset, second]),
      );
      expect(await f.project.assets.list("doc-1")).toHaveLength(2);
      const snapshots = new ProjectGitSnapshots(f.content),
        current = await snapshots.head();
      expect(current).not.toBe(before);
      await expect(
        f.project.assets.put({ ...f.asset, id: "foreign", documentId: "missing" }, "foreign", author),
      ).rejects.toThrow("notFound");
      expect(await snapshots.head()).toBe(current);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "asset storage refuses unowned and overlapping roots, symlinks and corrupt existing bytes",
  async () => {
    const f = await fixture();
    try {
      await expect(openProjectAssetDirectory(f.content.directory, f.content)).rejects.toThrow("unowned");
      const hidden = join(f.content.directory, "..assets");
      await mkdir(hidden);
      await expect(openProjectAssetDirectory(hidden, f.content)).rejects.toThrow("unowned");
      const unownedRoot = join(f.root, "unowned"),
        unownedProject = join(unownedRoot, "projects", "project-1");
      await mkdir(unownedProject, { recursive: true });
      await writeFile(join(unownedProject, "original.txt"), "unrelated bytes");
      await expect(openProjectAssetDirectory(unownedRoot, f.content)).rejects.toThrow("unowned");
      expect(await readFile(join(unownedProject, "original.txt"), "utf8")).toBe("unrelated bytes");
      const outside = join(f.root, "outside");
      await writeFile(outside, "external bytes");
      const path = join(f.owned.blobs, f.asset.digest);
      await symlink(outside, path);
      await expect(f.blobs.put(f.asset.digest, f.bytes)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("external bytes");
      await unlink(path);
      await writeFile(path, "corrupt existing bytes");
      await expect(f.blobs.put(f.asset.digest, f.bytes)).rejects.toThrow("invalidFile");
      expect(await readFile(path, "utf8")).toBe("corrupt existing bytes");
    } finally {
      await f.close();
    }
  },
  30000,
);
