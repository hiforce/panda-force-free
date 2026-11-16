import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentCoordinator } from "../../src/server/project-content/coordinator.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { ProjectContentJournal } from "../../src/server/project-content/journal.js";
import { stableJson } from "../../src/shared/stable-json.js";

const author = { name: "Content author", email: "content@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-content-planner-")),
    owned = await createOwnedProjectDirectory(root, "project-1");
  return {
    root,
    owned,
    coordinator: new ProjectContentCoordinator(owned),
    snapshots: new ProjectGitSnapshots(owned),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("planned mutations observe latest queued state and replay original receipts without rerunning preparation", async () => {
  const f = await fixture();
  try {
    const command = { operationId: "first", author, message: "Update metadata", intent: "v1:first-counter" };
    const increase = async (view: Parameters<Parameters<typeof f.coordinator.transact>[1]>[0]) => {
      const previous = await view.read("tree.json"),
        count = previous === null ? 0 : Number(previous.toString());
      return [
        { path: "tree.json", content: String(count + 1) },
        { path: "project.json", content: "same-transaction-" + (count + 1) },
      ];
    };
    const [one, two] = await Promise.all([
      f.coordinator.transact(command, increase),
      f.coordinator.transact({ ...command, operationId: "second", intent: "v1:second-counter" }, increase),
    ]);
    expect(two.base).toBe(one.commit);
    expect((await f.coordinator.read(["tree.json"])).files.get("tree.json")?.toString()).toBe("2");
    expect(
      await f.coordinator.transact(command, async () => {
        throw Error("Replay must not plan");
      }),
    ).toEqual(one);
    expect(await f.snapshots.fileAt(one.commit, "project.json")).toEqual(Buffer.from("same-transaction-1"));
    await expect(f.coordinator.transact({ ...command, intent: "different" }, increase)).rejects.toThrow("conflict");
    await expect(
      f.coordinator.transact({ ...command, author: { ...author, email: "other@example.test" } }, increase),
    ).rejects.toThrow("conflict");
  } finally {
    await f.close();
  }
}, 30000);

test("a failed or conflicting plan changes no files and releases the shared owner", async () => {
  const f = await fixture();
  try {
    const command = { operationId: "failed", author, message: "Save metadata", intent: "v1:failed-plan" },
      before = await f.snapshots.head();
    await expect(
      f.coordinator.transact(command, async () => {
        throw Error("Invalid topology");
      }),
    ).rejects.toThrow("Invalid topology");
    expect(await f.snapshots.head()).toBe(before);
    expect(await new ProjectContentJournal(f.owned).receipt("failed")).toBeNull();
    await f.coordinator.mutate({
      operationId: "create",
      author,
      message: "Create tree",
      changes: [{ path: "tree.json", content: "original" }],
    });
    await writeFile(join(f.owned.directory, "tree.json"), "external bytes");
    await expect(
      f.coordinator.transact({ ...command, operationId: "external" }, async () => [
        { path: "project.json", content: "must not exist" },
        { path: "tree.json", content: "replacement" },
      ]),
    ).rejects.toThrow("conflict");
    expect(await Bun.file(join(f.owned.directory, "project.json")).exists()).toBe(false);
    expect(await readFile(join(f.owned.directory, "tree.json"), "utf8")).toBe("external bytes");
  } finally {
    await f.close();
  }
}, 30000);

test("direct mutation fingerprints remain compatible with the original persisted receipt contract", async () => {
  const f = await fixture();
  try {
    const base = await f.snapshots.head(),
      content = "original",
      operationId = "legacy-contract",
      message = "Save original";
    const oldHash = createHash("sha256")
      .update(
        stableJson({
          operationId,
          base,
          message,
          author: { name: author.name, email: author.email },
          changes: [{ path: "tree.json", digest: createHash("sha256").update(content).digest("hex") }],
        }),
      )
      .digest("hex");
    const saved = await f.coordinator.mutate({
      operationId,
      base,
      author,
      message,
      changes: [{ path: "tree.json", content }],
    });
    expect(saved.requestHash).toBe(oldHash);
    expect(
      (
        await new ProjectContentCoordinator(f.owned).mutate({
          operationId,
          base,
          author,
          message,
          changes: [{ path: "tree.json", content }],
        })
      ).commit,
    ).toBe(saved.commit);
  } finally {
    await f.close();
  }
});
