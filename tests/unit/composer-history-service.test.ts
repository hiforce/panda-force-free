import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readComposerHistory } from "../../src/server/conversation/composer-history.js";

test("CLI history handles absent files, malformed rows, limits and truncated tails", async () => {
  const root = mkdtempSync(join(tmpdir(), "composer-history-"));
  try {
    expect(await readComposerHistory(root)).toEqual([]);
    const row = (text) => JSON.stringify({ session_id: "thread", text }) + "\n";
    writeFileSync(join(root, "history.jsonl"), row("old") + "invalid\n" + row("多行\n消息") + row("new") + '{"text":');
    expect(await readComposerHistory(root, { limit: 2 })).toEqual([{ text: "多行\n消息" }, { text: "new" }]);
    expect(await readComposerHistory(root, { maxBytes: Buffer.byteLength(row("new")) + 10 })).toEqual([
      { text: "new" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped history keeps prompts only for approved sessions and never returns source session identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "composer-history-scope-"));
  try {
    writeFileSync(
      join(root, "history.jsonl"),
      [
        { session_id: "inside", text: "First" },
        { session_id: "outside", text: "External prompt" },
        { text: "Unknown origin" },
        { session_id: "inside", text: "Second" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const checked: string[] = [];
    expect(
      await readComposerHistory(root, {
        includeSession: async (id) => {
          checked.push(id);
          return id === "inside";
        },
      }),
    ).toEqual([{ text: "First" }, { text: "Second" }]);
    expect(checked).toEqual(["inside", "outside"]);
    expect(await readComposerHistory(root)).toHaveLength(4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
