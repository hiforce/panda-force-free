import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readComposerHistory, readComposerHistoryPage } from "../../src/server/conversation/composer-history.js";

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

test("input recall pages traverse intact multibyte prompts and filter every page by session", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-pages-"));
  try {
    const records = Array.from({ length: 105 }, (_, index) => ({
      session_id: index % 5 ? "allowed" : "denied",
      text: `Prompt ${index} 漢字🙂`,
    }));
    writeFileSync(join(root, "history.jsonl"), records.map((row) => JSON.stringify(row) + "\n").join(""));
    let cursor,
      combined = [],
      pages = 0;
    do {
      const page = await readComposerHistoryPage(root, {
        cursor,
        limit: 7,
        includeSession: async (id) => id === "allowed",
      });
      expect(page.entries.length).toBeLessThanOrEqual(7);
      expect(page.entries.every((entry) => Object.keys(entry).join() === "text")).toBe(true);
      combined = [...page.entries, ...combined];
      cursor = page.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(40);
    } while (cursor);
    expect(combined).toEqual(records.filter((row) => row.session_id === "allowed").map(({ text }) => ({ text })));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("input recall keeps full long prompts, survives appends and rejects changed file cursors", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-cursor-")),
    path = join(root, "history.jsonl");
  const long = "完整的長文🙂".repeat(2000),
    row = (text) => JSON.stringify({ session_id: "a", text }) + "\n";
  try {
    writeFileSync(path, row("oldest") + row(long) + row("recent"));
    const first = await readComposerHistoryPage(root, { byteBudget: 1024 });
    expect(first.entries).toEqual([{ text: "recent" }]);
    appendFileSync(path, row("appended"));
    const middle = await readComposerHistoryPage(root, { cursor: first.nextCursor, byteBudget: 1024 });
    expect(middle.entries).toEqual([{ text: long }]);
    const last = await readComposerHistoryPage(root, { cursor: middle.nextCursor, byteBudget: 1024 });
    expect(last.entries).toEqual([{ text: "oldest" }]);
    expect(last.nextCursor).toBeNull();
    expect((await readComposerHistoryPage(root)).entries.at(-1)).toEqual({ text: "appended" });
    writeFileSync(path, row("truncated"));
    await expect(readComposerHistoryPage(root, { cursor: first.nextCursor })).rejects.toThrow("cursor");
    renameSync(path, path + ".old");
    writeFileSync(path, row("replacement"));
    await expect(readComposerHistoryPage(root, { cursor: first.nextCursor })).rejects.toThrow("cursor");
    await expect(readComposerHistoryPage(root, { cursor: "untrusted" })).rejects.toThrow("cursor");
    await expect(readComposerHistoryPage(root, { limit: 0 })).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded history windows preserve rows cut at their oldest boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "history-window-"));
  const texts = ["old".repeat(45), "middle".repeat(10), "new"];
  try {
    writeFileSync(join(root, "history.jsonl"), texts.map((text) => JSON.stringify({ text }) + "\n").join(""));
    const first = await readComposerHistoryPage(root, { maxBytes: 200 });
    const second = await readComposerHistoryPage(root, { maxBytes: 200, cursor: first.nextCursor });
    expect([...second.entries, ...first.entries]).toEqual(texts.map((text) => ({ text })));
    expect(second.nextCursor).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
