import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { creationToolActivity } from "../../src/server/creation/runtime/activity.js";
import { creationProgress } from "../../src/server/creation/validation.js";
import type { CreationProgress } from "../../src/shared/creation/contracts.js";
import type { CreationLease } from "../../src/server/creation/contracts.js";

const lease = { owner: "alice", taskId: randomUUID(), generation: 1, token: "test" } as unknown as CreationLease;
test("creation tool activity exposes real running and terminal states without tool arguments", async () => {
  const events: CreationProgress[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = creationToolActivity(
    {
      record: async (_lease, event) => {
        events.push(structuredClone(creationProgress(event)));
      },
      list: async () => [],
    },
    lease,
    "panda_images_render",
    async () => {
      await gate;
      return { success: true, text: "Private artifact handle" };
    },
    () => 100,
    () => {},
  );
  await Bun.sleep(1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ operation: "panda_images_render", status: "running", at: 100 });
  release();
  await running;
  expect(events[1]).toEqual({ ...events[0]!, status: "completed" });
  expect(JSON.stringify(events)).not.toContain("Private");
  expect(events[0]?.id).toBe(events[1]?.id);
});

test("progress persistence failure cannot replay a tool and operation failures remain visible", async () => {
  let calls = 0,
    diagnostics = 0;
  const failing = {
    record: async () => {
      throw Error("Storage offline");
    },
    list: async () => [],
  };
  expect(
    (
      await creationToolActivity(
        failing,
        lease,
        "panda_documents_create",
        async () => {
          calls++;
          return { success: true, text: "Saved" };
        },
        () => 1,
        () => {
          diagnostics++;
        },
      )
    ).success,
  ).toBe(true);
  expect(calls).toBe(1);
  expect(diagnostics).toBe(2);
  const events: CreationProgress[] = [];
  await expect(
    creationToolActivity(
      {
        record: async (_l, e) => {
          events.push(e);
        },
        list: async () => [],
      },
      lease,
      "panda_slides_render",
      async () => {
        throw Error("Provider exception");
      },
      () => 2,
      () => {},
    ),
  ).rejects.toThrow("Provider exception");
  expect(events.map((e) => e.status)).toEqual(["running", "failed"]);
  expect(() =>
    creationProgress({ at: 1, generation: 1, stage: "activity", operation: "raw_command" as never, status: "running" }),
  ).toThrow();
});
