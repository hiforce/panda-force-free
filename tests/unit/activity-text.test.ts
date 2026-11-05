import { expect, test } from "bun:test";
import { activityText, mergeReasoningItem } from "../../src/shared/activity-text.js";

test("native public reasoning text blocks remain readable without inspecting encrypted fields", () => {
  expect(activityText(["First", { type: "summary_text", text: "Second" }, { type: "text", text: "Third" }])).toBe(
    "First\nSecond\nThird",
  );
  expect(activityText({ type: "reasoning", encrypted_content: "not-readable" })).toBe("");
  expect(activityText([{ type: "encrypted_content", text: "not-a-public-text-block" }])).toBe("");
});
test("completion preserves a streamed summary instead of replacing it with an empty array", () => {
  const streamed = {
    id: "one",
    type: "reasoning",
    status: "inProgress",
    summary: [{ type: "summary_text", text: "Public summary" }],
  };
  const completed = mergeReasoningItem(streamed, { id: "one", type: "reasoning", status: "completed", summary: [] });
  expect(activityText(completed.summary)).toBe("Public summary");
  expect(completed.status).toBe("completed");
});
