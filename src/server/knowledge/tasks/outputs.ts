import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeContent, KnowledgeTaskFiles } from "./contracts.js";
import { KnowledgeTaskError, KnowledgeWriteConflict } from "./contracts.js";
import type { KnowledgeTaskStore } from "./contracts.js";
import { taskKnowledgeContext } from "./evidence-context.js";
import { validateKnowledgeEvidence } from "../evidence.js";
import { stableJson } from "../../../shared/stable-json.js";
import { isKnowledgeAccessDenied } from "./access.js";
/** Admitted file writes recover from their durable digest and project operation receipt after process failure. */
export class KnowledgeOutputs {
  private readonly active = new Map<string, Promise<void>>();
  constructor(
    private readonly ledger: Pick<
      MetadataStore<KnowledgeTaskStore>,
      "get" | "complete" | "outputFailed" | "rejectDelivery" | "denyDelivery"
    >,
    private readonly files: KnowledgeTaskFiles,
    private readonly content: KnowledgeContent,
    private readonly now: () => number = Date.now,
  ) {}
  reconcile(owner: string, id: string): Promise<void> {
    const key = owner + ":" + id,
      previous = this.active.get(key);
    if (previous) return previous;
    const work = this.save(owner, id).finally(() => {
      if (this.active.get(key) === work) this.active.delete(key);
    });
    this.active.set(key, work);
    return work;
  }
  private async save(owner: string, id: string) {
    const task = await this.ledger.get(owner, id);
    if (task.state === "completed") return;
    if (task.state !== "committing" || !task.outputDigest) throw new KnowledgeTaskError("conflict");
    try {
      const [input, dialogue, record] = await Promise.all([
        this.files.input(task.inputDigest),
        this.files.dialogue(task.dialogueDigest),
        this.files.output(task.outputDigest),
      ]);
      if (record.taskId !== id) throw new KnowledgeTaskError("conflict");
      const draft = {
        ...record.draft,
        claims: record.draft.claims.map((claim) => ({
          ...claim,
          evidence: claim.evidence.map(({ sourceId, version, quote, start, section }) => ({
            sourceId,
            version,
            quote,
            start,
            ...(section === undefined ? {} : { section }),
          })),
        })),
      };
      if (
        stableJson(validateKnowledgeEvidence(draft, await taskKnowledgeContext(this.files, input, dialogue))) !==
        stableJson(record.draft)
      )
        throw new KnowledgeTaskError("conflict");
      const recovered = await this.content.recover?.(owner, input, record, async () => {
        try {
          await this.content.authorize(owner, input.scope.project);
        } catch (error) {
          if (isKnowledgeAccessDenied(error)) await this.ledger.denyDelivery(owner, id, task.outputDigest!, this.now());
          throw error;
        }
      });
      if (recovered) {
        await this.ledger.complete(owner, id, task.outputDigest, recovered.receipt, this.now(), recovered.projection);
        return;
      }
      await this.content.authorize(owner, input.scope.project);
      const receipt = await this.content.save(owner, input, record, async () => {
        const current = await this.ledger.get(owner, id);
        if (current.state !== "committing" || current.outputDigest !== task.outputDigest)
          throw new KnowledgeTaskError("conflict");
      });
      const projection = await this.content.projection?.(owner, input, record, receipt);
      await this.ledger.complete(owner, id, task.outputDigest, receipt, this.now(), projection);
    } catch (error) {
      if (error instanceof KnowledgeWriteConflict)
        await this.ledger.rejectDelivery(owner, id, task.outputDigest, error.reason, this.now());
      else await this.ledger.outputFailed(owner, id, task.outputDigest, this.now());
      throw error;
    }
  }
  async drain() {
    await Promise.allSettled([...this.active.values()]);
  }
}
