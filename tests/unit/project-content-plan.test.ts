import { expect, test } from "bun:test";
import { ProjectContentPlan } from "../../src/server/project-content/plan-view.js";
import type { ProjectContentView } from "../../src/server/project-content/read-view.js";
import { PROJECT_CONTENT_LIMITS } from "../../src/server/project-content/limits.js";

function fixture() {
  let active = true;
  const files = new Map([["project.json", Buffer.from("original")]]),
    assertHeld = () => {
      if (!active) throw Error("Closed snapshot");
    },
    base: ProjectContentView = {
      commit: "a".repeat(40),
      paths: [...files.keys()],
      assertHeld,
      read: async (path) => {
        assertHeld();
        return files.get(path) ?? null;
      },
      inspect: async (path, work) => {
        assertHeld();
        const bytes = files.get(path);
        if (!bytes) throw Error("Missing file");
        return work({
          size: bytes.length,
          read: async (offset, length) => Buffer.from(bytes.subarray(offset, offset + length)),
        });
      },
    };
  return {
    plan: new ProjectContentPlan(base),
    files,
    close: () => {
      active = false;
    },
  };
}
test("project plans detach staged inputs and reads while composing metadata without writing the base", async () => {
  const f = fixture(),
    input = Buffer.from("first");
  f.plan.apply([{ path: "tree.json", content: input }]);
  input.fill(120);
  const body = await f.plan.read("tree.json");
  body!.fill(121);
  const changes = f.plan.changes();
  (changes[0]!.content as Buffer).fill(122);
  expect((await f.plan.read("tree.json"))!.toString()).toBe("first");
  expect(await f.plan.inspect("tree.json", async (file) => (await file.read(1, 2)).toString())).toBe("ir");
  f.plan.apply([
    { path: "tree.json", content: "second" },
    { path: "project.json", content: null },
  ]);
  expect(f.plan.paths).toEqual(["tree.json"]);
  expect(await f.plan.read("project.json")).toBeNull();
  expect(f.files.get("project.json")!.toString()).toBe("original");
  expect(f.files.has("tree.json")).toBe(false);
  f.close();
  await expect(f.plan.read("tree.json")).rejects.toThrow("Closed snapshot");
  expect(() => f.plan.changes()).toThrow("Closed snapshot");
});
test("a failed planning batch cannot replace an earlier source revision or leak partial metadata", async () => {
  const f = fixture();
  f.plan.apply([{ path: "documents/doc.panda.json", content: "promised source" }]);
  expect(() =>
    f.plan.apply([
      { path: "tree.json", content: "partial" },
      { path: "documents/doc.panda.json", content: "replacement" },
    ]),
  ).toThrow("conflict");
  expect(f.plan.paths).toEqual(["documents/doc.panda.json", "project.json"]);
  expect((await f.plan.read("documents/doc.panda.json"))!.toString()).toBe("promised source");
  expect(() => f.plan.apply([{ path: "../outside", content: "invalid" }])).toThrow("invalidFile");
  expect(f.plan.changes()).toHaveLength(1);
});
test("staged readers retain scope and cumulative limits when callbacks outlive their project view", async () => {
  const f = fixture();
  f.plan.apply([{ path: "tree.json", content: "bounded" }]);
  let finish = () => {};
  const gate = new Promise<void>((done) => {
      finish = done;
    }),
    pending = f.plan.inspect("tree.json", async (file) => {
      const bytes = await file.read(0, 7);
      await gate;
      return bytes;
    });
  f.close();
  finish();
  await expect(pending).rejects.toThrow("Closed snapshot");
  const budget = fixture(),
    bytes = Buffer.alloc(1024 * 1024);
  budget.plan.apply([{ path: "tree.json", content: bytes }]);
  for (let n = 0; n < PROJECT_CONTENT_LIMITS.operationBytes / bytes.length; n++) await budget.plan.read("tree.json");
  await expect(budget.plan.read("tree.json")).rejects.toThrow("invalidFile");
});
