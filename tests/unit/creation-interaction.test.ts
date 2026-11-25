import { expect, test } from "bun:test";
import { applicationVisibleEvents } from "../../src/shared/engine/application-visible-events.js";
import type { ApplicationVisibleEvent } from "../../src/shared/engine/application-tools.js";
import { creationDraftAfterAcknowledgement } from "../../src/client/creation/submitted-draft.js";

test("an acknowledgement preserves new text, new uploads and changed skill choices", () => {
  const draft = {
    text: "A newer draft",
    mentions: [],
    attachments: [
      { id: "old", materialId: "sent", name: "sent.txt", kind: "file" as const, status: "ready" as const },
      { id: "new", materialId: "next", name: "next.txt", kind: "file" as const, status: "ready" as const },
    ],
    skills: [
      { packageId: "example", version: "1.0", digest: "original", id: "used", parameters: {} },
      { packageId: "example", version: "1.0", digest: "original", id: "changed", parameters: { detail: "new" } },
    ],
  };
  const next = creationDraftAfterAcknowledgement(
    draft,
    "Submitted text",
    ["sent"],
    [draft.skills[0]!, { ...draft.skills[1]!, parameters: { detail: "old" } }],
  );
  expect(next.text).toBe("A newer draft");
  expect(next.attachments.map((file) => file.id)).toEqual(["new"]);
  expect(next.skills).toEqual([draft.skills[1]!]);
  expect(draft.attachments).toHaveLength(2);
  expect(
    creationDraftAfterAcknowledgement({ ...draft, text: " Submitted text " }, "Submitted text", ["sent"]).text,
  ).toBe("");
});

test("public events accumulate one message and expose numeric usage without transport or reasoning data", () => {
  const events: ApplicationVisibleEvent[] = [];
  const receive = applicationVisibleEvents((event) => events.push(event));
  receive("item/agentMessage/delta", { itemId: "a", delta: "Hello" });
  receive("item/agentMessage/delta", { itemId: "a", delta: " world" });
  receive("item/reasoning/summaryTextDelta", { itemId: "secret", delta: "Private reasoning" });
  receive("item/completed", { item: { id: "cmd", type: "commandExecution", arguments: "private path" } });
  receive("thread/tokenUsage/updated", {
    tokenUsage: {
      total: { totalTokens: 42, secret: "private" },
      last: { inputTokens: -1 },
      modelContextWindow: 1000,
      transport: { token: "private" },
    },
  });
  expect(events).toHaveLength(3);
  expect(events[1]).toEqual({ kind: "message", id: "a", text: "Hello world", complete: false });
  expect(JSON.stringify(events)).not.toContain("private");
  expect(JSON.stringify(events)).not.toContain("reasoning");
  receive("item/completed", {
    item: { id: "a", type: "agentMessage", text: "Complete reply", phase: "final_answer", secret: "private" },
  });
  expect(events.at(-1)).toEqual({
    kind: "message",
    id: "a",
    text: "Complete reply",
    complete: true,
    phase: "final_answer",
  });
});

test("guidance-only snapshots require an explicit decoder mode while document workflows stay strict", async () => {
  const { decodeSkillComposition } = await import("../../src/shared/skills/capture-codec.js");
  const selection = {
    packageId: "example.guidance",
    version: "1.0.0",
    digest: "a".repeat(64),
    id: "template",
    qualifiedId: "example.guidance/template",
    role: "template",
    instructions: "Organize the supplied content.",
    parameters: {},
  };
  const composition = { schema: 1, outputType: "document", skills: [selection], capabilities: [], constraints: {} };
  expect(() => decodeSkillComposition(composition)).toThrow("workflowRequired");
  expect(decodeSkillComposition(composition, { workflowRequired: false }).skills[0]!.role).toBe("template");
  expect(() =>
    decodeSkillComposition(
      {
        ...composition,
        skills: [
          { ...selection, role: "workflow" },
          { ...selection, id: "other", qualifiedId: "example.guidance/other", role: "workflow" },
        ],
      },
      { workflowRequired: false },
    ),
  ).toThrow("workflowRequired");
});
