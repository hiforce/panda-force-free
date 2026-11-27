import type { HarnessConversation } from "../../../shared/harness/contracts.js";
import type { HarnessMetadata } from "../ports.js";
import { nativeMemoryKind } from "../../project-memory/records.js";
import { decode, save } from "../records.js";
import { historyArchiveInterval } from "./history-archive.js";
import type { JsonlHarnessHistory } from "./history.js";

const retryMs = 60 * 60_000;
const key = (id: string) => `history-archive-maintenance:${id}`;
const dueKind = "history-archive-maintenance";

export class HarnessHistoryMaintenance {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private readonly stop = new AbortController();

  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly history: JsonlHarnessHistory,
    private readonly now = Date.now,
  ) {}

  start() {
    this.timer ??= setInterval(() => this.wake(), retryMs);
    this.timer.unref();
    this.wake();
  }

  wake() {
    this.work ??= this.run()
      .catch(() => {})
      .finally(() => {
        this.work = undefined;
      });
  }

  async close() {
    clearInterval(this.timer);
    this.stop.abort();
    await this.work;
  }

  async run() {
    const [conversations, native] = await Promise.all([
      this.metadata.list("conversation"),
      this.metadata.list(nativeMemoryKind),
    ]);
    const sessions = [...conversations, ...native];
    const scheduled = new Map(
      (await this.metadata.list(dueKind)).map((row) => [row.id, decode<{ due: number }>(row)!.due]),
    );
    for (const row of sessions) {
      if (this.stop.signal.aborted) return;
      const source = decode<HarnessConversation>(row)!;
      if (!source.historyBytes || source.activeRunId || (scheduled.get(key(source.id)) ?? 0) > this.now()) continue;
      try {
        await this.rotate(row.id, source);
      } catch {
        // The committed hot history remains available, and the next sweep can recover safely.
      }
    }
  }

  private async rotate(rowId: string, source: HarnessConversation) {
    const prepared = await this.history.prepareRotation(source.owner, source.id, source.historyBytes, this.stop.signal);
    try {
      await this.metadata.transaction(async (tx) => {
        if (this.stop.signal.aborted) return;
        const current = decode<HarnessConversation>(await tx.get(rowId));
        const previous = decode<{ due: number }>(await tx.get(key(source.id)));
        if (previous && previous.due > this.now()) return;
        if (
          !current ||
          current.owner !== source.owner ||
          current.activeRunId ||
          current.historyBytes !== source.historyBytes
        )
          return;
        if (prepared && !(await prepared.publish())) return;
        await save(tx, key(source.id), dueKind, source.owner, { due: this.now() + historyArchiveInterval });
      });
    } finally {
      await prepared?.discard();
    }
  }
}
