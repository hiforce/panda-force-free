import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAttachmentWorkspace } from "../../src/server/workspace/attachment-workspace.js";
import { attachmentWorkspaceContext, stripAttachmentWorkspaceContext } from "../../src/shared/attachment-workspace.js";
import { buildComposerInput, composerInputKey, composerTextFromInput } from "../../src/client/composer-attachments.js";
import { readComposerHistory } from "../../src/server/conversation/composer-history.js";

test("attachment directories preserve a stable identity and separate session processing and outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "attachment-workspace-"));
  try {
    const first = ensureAttachmentWorkspace(root, [root], "session-a");
    writeFileSync(join(first.output, "原件 01.pdf"), "retained bytes");
    const second = ensureAttachmentWorkspace(root, [root], "session-b");
    expect(first.input).toBe(second.input);
    expect(first.work).not.toBe(second.work);
    expect(first.output).not.toBe(second.output);
    expect(first.markerId).toBe(second.markerId);
    expect(JSON.parse(readFileSync(first.marker, "utf8")).id).toBe(first.markerId);
    expect(statSync(first.marker).mode & 0o777).toBe(0o600);
    expect(statSync(first.work).mode & 0o777).toBe(0o700);
    expect(ensureAttachmentWorkspace(root, [root], "session-a")).toEqual(first);
    expect(readFileSync(join(first.output, "原件 01.pdf"), "utf8")).toBe("retained bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment paths reject outside roots and session traversal before creating directories", () => {
  const root = mkdtempSync(join(tmpdir(), "attachment-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "attachment-outside-"));
  try {
    expect(() => ensureAttachmentWorkspace(outside, [root], "session")).toThrow("outside");
    for (const id of ["../outside", "/absolute", "a/b", "a\\b", "", "a".repeat(129)])
      expect(() => ensureAttachmentWorkspace(root, [root], id)).toThrow("session");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("concurrent workers publish one complete shared-workspace identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "attachment-concurrent-"));
  try {
    const module = new URL("../../src/server/workspace/attachment-workspace.ts", import.meta.url).pathname;
    const workers = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          "const {ensureAttachmentWorkspace}=await import(process.argv[1]);process.stdout.write(ensureAttachmentWorkspace(process.argv[2],[process.argv[2]],process.argv[3]).markerId)",
          module,
          root,
          `session-${index}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const results = await Promise.all(
      workers.map(async (worker) => ({
        code: await worker.exited,
        output: await new Response(worker.stdout).text(),
        error: await new Response(worker.stderr).text(),
      })),
    );
    expect(results.map((result) => ({ code: result.code, error: result.error }))).toEqual(
      Array.from({ length: 8 }, () => ({ code: 0, error: "" })),
    );
    expect(new Set(results.map((result) => result.output)).size).toBe(1);
    expect(ensureAttachmentWorkspace(root, [root], "after-restart").markerId).toBe(results[0].output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const component of [
  "attachments",
  "attachments/input",
  "attachments/work",
  "attachments/output",
  "attachments/work/session",
  "attachments/output/session",
  "attachments/.panda-attachments.json",
]) {
  test(`rejects a symlink at ${component} without writing into its target`, () => {
    const root = mkdtempSync(join(tmpdir(), "attachment-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "attachment-target-"));
    try {
      ensureAttachmentWorkspace(root, [root], "session");
      const linked = join(root, component);
      rmSync(linked, { recursive: true, force: true });
      symlinkSync(outside, linked);
      expect(() => ensureAttachmentWorkspace(root, [root], "session")).toThrow();
      expect(statSync(outside).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

test("reserved paths cannot overwrite existing files or an unrecognized workspace marker", () => {
  const root = mkdtempSync(join(tmpdir(), "attachment-existing-"));
  try {
    mkdirSync(join(root, "attachments"));
    const marker = join(root, "attachments", ".panda-attachments.json");
    writeFileSync(marker, '{"product":"unrelated"}');
    expect(() => ensureAttachmentWorkspace(root, [root], "session")).toThrow("marker");
    expect(readFileSync(marker, "utf8")).toBe('{"product":"unrelated"}');
    rmSync(marker);
    writeFileSync(join(root, "attachments", "input"), "existing project file");
    expect(() => ensureAttachmentWorkspace(root, [root], "session")).toThrow("regular directory");
    expect(readFileSync(join(root, "attachments", "input"), "utf8")).toBe("existing project file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native workspace context keeps visible prompts, attachment identity and composer history unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "attachment-context-"));
  try {
    const paths = ensureAttachmentWorkspace(root, [root], "session");
    const context = attachmentWorkspaceContext(paths);
    const files = [
      { id: "file", name: "原件 01.pdf", kind: "file", status: "ready", path: join(paths.input, "原件 01.pdf") },
      { id: "image", name: "截图.png", kind: "image", status: "ready", path: join(paths.input, "截图.png") },
    ];
    const original = buildComposerInput("Keep my\nmultiline message", files);
    const augmented = [...original, { type: "text", text: context }];
    expect(composerTextFromInput(augmented)).toBe("Keep my\nmultiline message");
    expect(composerInputKey(augmented)).toBe(composerInputKey(original));
    const text = augmented
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const originalText = original
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(stripAttachmentWorkspaceContext(text)).toBe(originalText);
    expect(composerInputKey([{ type: "text", text }, original.at(-1)!])).toBe(composerInputKey(original));
    writeFileSync(join(root, "history.jsonl"), JSON.stringify({ session_id: "session", text }) + "\n");
    expect(await readComposerHistory(root)).toEqual([{ text: originalText }]);
    expect(stripAttachmentWorkspaceContext("A code sample mentions <panda_attachment_workspace> inline.")).toBe(
      "A code sample mentions <panda_attachment_workspace> inline.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
