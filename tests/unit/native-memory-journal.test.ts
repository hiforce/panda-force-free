import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { NativeMemoryJournal } from "../../src/server/project-memory/native-journal.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import { memoryFixtureOrganizer, memoryFixturePolicy } from "../support/memory-organization.js";

test("native memory journals completed turns from the enabled interval and resumes after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-native-memory-"));
  const metadata = new SQLiteHarnessMetadata(join(directory, "memory.sqlite"));
  let now = Date.now();
  const history = new JsonlHarnessHistory(directory, () => now);
  const destination = { owner: "owner", id: "native-thread", projectId: "atlas", cwd: directory };
  const memory = new ProjectMemory(
    metadata,
    history,
    async () => {},
    undefined,
    () => now,
    undefined,
    memoryFixtureOrganizer,
    undefined,
    undefined,
    async (id) => (id === destination.id ? { projectId: destination.projectId, checkpoint: null } : null),
  );
  let journal = new NativeMemoryJournal(metadata, history, memory, () => now);
  const cause = (method: "turn/started" | "turn/completed", turnId: string, text?: string) => {
    now++;
    journal.observe({
      method,
      params: {
        threadId: destination.id,
        turn: {
          id: turnId,
          ...(method === "turn/completed" ? { status: "completed" } : {}),
          ...(text
            ? { items: [{ id: "item-" + turnId, type: "userMessage", content: [{ type: "text", text }] }] }
            : {}),
        } as { id: string },
      },
    });
  };
  const drain = async () => {
    await journal.close();
    journal = new NativeMemoryJournal(metadata, history, memory, () => now);
    await memory.processPending();
  };
  async function waitForEntries(count: number) {
    for (let index = 0; index < 80; index++) {
      const entries = await memory.catalog(destination.owner, destination.projectId);
      if (entries.length >= count) return entries;
      await Bun.sleep(25);
    }
    return memory.catalog(destination.owner, destination.projectId);
  }
  try {
    await memory.configure(destination.owner, destination.projectId, {
      revision: 0,
      write: true,
      recall: true,
      model: memoryFixturePolicy,
    });
    expect((await journal.view(destination)).enabled).toBe(false);
    cause("turn/started", "already-running");
    await drain();
    await journal.configure(destination, 0, true);
    cause("turn/completed", "already-running", "Project convention: old turn = never recorded");
    cause("turn/started", "new-turn");
    now++;
    journal.observe({
      method: "item/completed",
      params: {
        threadId: destination.id,
        turnId: "new-turn",
        item: {
          id: "current-user",
          type: "userMessage",
          content: [{ type: "text", text: "Project convention: archive interval = once a week" }],
        },
      },
    });
    // The item was journaled by the previous process, and completion can arrive after it restarts.
    await drain();
    cause("turn/completed", "new-turn");
    cause("turn/completed", "new-turn");
    await drain();
    const expected = await waitForEntries(1);
    expect(expected.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "archive-interval", value: "once a week" },
    ]);
    expect(expected[0]!.sources).toHaveLength(1);
    const entry = expected[0]!.sources[0]!;
    const before = await journal.view(destination);
    expect(before.contributed).toBe(1);
    cause("turn/started", "interrupted-by-pause");
    await drain();
    await journal.configure(destination, before.revision, false);
    cause("turn/completed", "interrupted-by-pause", "Project convention: paused remark = must stay out");
    cause("turn/started", "pause");
    cause("turn/completed", "pause", "Project convention: paused remark = must stay out");
    await drain();
    const paused = await journal.view(destination);
    expect(paused.paused).toBe(true);
    await journal.configure(destination, paused.revision, true);
    cause("turn/started", "resumed");
    cause("turn/completed", "resumed", "Project convention: active remark = included");
    await drain();
    expect((await waitForEntries(2)).map(({ key }) => key).sort()).toEqual(["active-remark", "archive-interval"]);
    const source = await memory.sourceLocation(
      destination.owner,
      destination.projectId,
      entry.conversationId,
      entry.messageId,
    );
    expect(source.message.text).toBe("Project convention: archive interval = once a week");
    await expect(
      memory.sourceLocation("other-owner", destination.projectId, entry.conversationId, entry.messageId),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await journal.close();
    await memory.close();
    await metadata.close();
    await rm(directory, { force: true, recursive: true });
  }
}, 30000);
