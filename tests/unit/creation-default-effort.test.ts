import { expect, test } from "bun:test";
import { defaultCreationEffort } from "../../src/shared/creation/effort.js";
import { CreationProfiles } from "../../src/server/creation/integration/profiles.js";

test("creation uses the strongest advertised effort instead of the model default", async () => {
  expect(defaultCreationEffort(["low", "medium", "high", "xhigh"], "low")).toBe("xhigh");
  expect(defaultCreationEffort(["medium", "high"], "medium")).toBe("high");
  expect(defaultCreationEffort(["medium"], "medium")).toBe("medium");
  let reads = 0;
  const catalog = {
    data: [
      {
        model: "writer",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })),
      },
    ],
  };
  const profiles = new CreationProfiles(
    { enabled: true, invalid: false, defaultProfileId: "writer", profiles: [{ id: "writer", engineId: "codex" }] },
    new Set(["codex"]),
    async (_engine, value) => {
      expect(value).toBe(catalog);
      return "writer";
    },
    async () => {
      reads++;
      return catalog;
    },
  );
  expect((await profiles.resolve("writer")).effort).toBe("xhigh");
  expect(reads).toBe(1);
  expect((await profiles.resolve("writer", { model: "writer", effort: "medium" })).effort).toBe("medium");
  catalog.data[0]!.supportedReasoningEfforts.pop();
  expect((await profiles.resolve("writer")).effort).toBe("high");
  await expect(profiles.resolve("writer", { model: "writer", effort: "xhigh" })).rejects.toThrow();
});

test("an explicitly configured creation profile retains its selected effort", async () => {
  const profiles = new CreationProfiles(
    {
      enabled: true,
      invalid: false,
      defaultProfileId: "custom",
      profiles: [{ id: "custom", engineId: "codex", model: "custom-model", effort: "medium" }],
    },
    new Set(["codex"]),
    async () => "unused",
    async () => {
      throw Error("Configured profile must not need a default effort lookup");
    },
  );
  expect(await profiles.resolve("custom")).toMatchObject({ model: "custom-model", effort: "medium" });
});

test("models without reasoning controls keep effort unset", async () => {
  const profiles = new CreationProfiles(
    { enabled: true, invalid: false, defaultProfileId: "writer", profiles: [{ id: "writer", engineId: "codex" }] },
    new Set(["codex"]),
    async () => "writer",
    async () => ({ data: [{ model: "writer", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] }] }),
  );
  expect((await profiles.resolve("writer")).effort).toBeUndefined();
  await expect(profiles.resolve("writer", { effort: "xhigh" })).rejects.toThrow();
});
