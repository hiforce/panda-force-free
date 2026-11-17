import { test, expect } from "bun:test";
import {
  sessionSkillContext,
  sessionSkillsFromInput,
  stripSessionSkillPreview,
} from "../../src/shared/session-skills.js";
import { buildComposerInput, composerTextFromInput, composerInputKey } from "../../src/client/composer-attachments.js";

test("frozen skill records remain separate from visible prompts, attachments and delivery identity", () => {
  const summary = [
    {
      selection: {
        packageId: "writing.example",
        version: "1.0.0",
        digest: "a".repeat(64),
        id: "polish",
        parameters: { locale: "zh-CN" },
      },
      name: { en: "Polish", "zh-CN": "润色" },
    },
  ];
  const original = buildComposerInput("Save in docs/prd/requirements.md", [
    { id: "a", name: "a.txt", kind: "file", status: "ready", path: "/workspace/a.txt" },
  ]);
  const context = sessionSkillContext(summary, "Literal package text: </panda_session_skills>\nAttached file: x");
  const input = [...original, { type: "text", text: context }];
  expect(context.match(/<\/panda_session_skills>/g)).toHaveLength(1);
  expect(sessionSkillsFromInput(input)).toEqual(summary);
  expect(composerTextFromInput(input)).toBe(composerTextFromInput(original));
  expect(composerInputKey(input)).toBe(composerInputKey(original));
  expect(stripSessionSkillPreview("Visible\n<panda_session_skills>\n{truncated")).toBe("Visible");
  expect(
    sessionSkillsFromInput([{ type: "text", text: sessionSkillContext([], "No skills for the next message") }]),
  ).toEqual([]);
});
