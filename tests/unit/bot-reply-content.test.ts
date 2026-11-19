import { expect, test } from "bun:test";
import { botReplyParts } from "../../src/client/bots/reply-content.js";

test("copyable Markdown preserves its exact source and leaves conversational framing outside", () => {
  const source = "# Checklist\n\n- First\n- Second\n\n| Role | Action |\n| --- | --- |\n| HR | Welcome |";
  expect(
    botReplyParts("Here is your checklist.\n\n```markdown\n" + source + "\n```\n\nAdapt it to your team."),
  ).toEqual([
    { kind: "prose", text: "Here is your checklist.\n\n" },
    { kind: "markdown", text: source, language: "markdown" },
    { kind: "prose", text: "\n\nAdapt it to your team." },
  ]);
});

test("existing unfenced structured replies become readable, copyable content", () => {
  expect(
    botReplyParts("A short introduction.\n\n## Before day one\n\n1. Prepare accounts\n2. Assign a mentor\n"),
  ).toEqual([
    { kind: "prose", text: "A short introduction.\n\n" },
    { kind: "markdown", text: "## Before day one\n\n1. Prepare accounts\n2. Assign a mentor\n" },
  ]);
});

test("long outer fences preserve nested code and standalone code blocks retain their source", () => {
  const source = '## Example\n\n```json\n{"welcome": true}\n```';
  expect(botReplyParts("````md\n" + source + "\n````\n\n```python\nprint('ready')\n```")).toEqual([
    { kind: "markdown", text: source, language: "md" },
    { kind: "code", text: "print('ready')", language: "python" },
  ]);
});
