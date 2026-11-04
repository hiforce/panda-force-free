import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalImagePresenter } from "../src/server/workspace/image-presentation.js";
import { itemImageReferences } from "../src/client/rendering.js";

test("history and notifications use saved image files without shipping base64 copies", () => {
  const root = mkdtempSync(join(tmpdir(), "image-presentation-"));
  try {
    const path = join(root, "成品06.png");
    writeFileSync(path, Buffer.from([137, 80, 78, 71]));
    const present = createLocalImagePresenter({ allowedRoots: [root] });
    const item = { type: "imageGeneration", id: "image-06", savedPath: path, status: "completed", result: "a".repeat(3 * 1024 * 1024) };
    const original = { method: "item/completed", params: { threadId: "task", item } };
    const notification = present(original);
    expect(notification.params.item.result).toBeUndefined();
    expect(notification.params.item.savedPath).toBe(path);
    expect(itemImageReferences(notification.params.item)).toEqual([{ source: path, title: "成品06.png" }]);
    expect(JSON.stringify(notification).length).toBeLessThan(500);
    expect(original.params.item.result.length).toBe(3 * 1024 * 1024);
    const history = present({ thread: { turns: [{ id: "turn", items: [item] }] } });
    expect(history.thread.turns[0].items[0]).toEqual(notification.params.item);
    expect(present(history)).toBe(history);
    const unavailable = { ...item, savedPath: join(root, "missing.png") };
    expect(present(unavailable)).toBe(unavailable);
    const outside = { ...item, savedPath: path };
    expect(createLocalImagePresenter({ allowedRoots: [] })(outside)).toBe(outside);
    const unrelated = { type: "mcpToolCall", result: "a".repeat(200), savedPath: path };
    expect(present(unrelated)).toBe(unrelated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
