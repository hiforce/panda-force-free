import type { KnowledgeReadDetail } from "../../../shared/knowledge/catalog.js";
import { knowledgeId, knowledgeObject } from "../../../shared/knowledge/task-validation.js";
import type { ApprovedKnowledgeReader } from "./contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";

/** Approved content is project-readable; private workflow state remains on the task service. */
export class KnowledgeRecords {
  private active = 0;
  private owners = new Map<string, number>();
  constructor(
    private readonly approved: ApprovedKnowledgeReader,
    private readonly limits = { perOwner: 2, total: 8 },
  ) {
    if (![limits.perOwner, limits.total].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 64))
      throw new KnowledgeTaskError("invalidInput");
    this.limits = Object.freeze({ ...limits });
  }
  async detail(owner: string, value: unknown): Promise<KnowledgeReadDetail> {
    const p = knowledgeObject(value, ["project", "id"]),
      scope = { owner, project: knowledgeId(p.project) },
      id = knowledgeId(p.id),
      count = this.owners.get(owner) ?? 0;
    if (count >= this.limits.perOwner || this.active >= this.limits.total) throw new KnowledgeTaskError("budget", 429);
    this.active++;
    this.owners.set(owner, count + 1);
    try {
      const values = await this.approved.current(scope, [id]),
        valueRead = values.find((value) => value.record.id === id);
      if (!valueRead) throw new KnowledgeTaskError("notFound", 404);
      return { record: valueRead.record, receipt: valueRead.receipt };
    } finally {
      this.active--;
      const pending = (this.owners.get(owner) ?? 1) - 1;
      if (pending) this.owners.set(owner, pending);
      else this.owners.delete(owner);
    }
  }
}
export function unavailableApprovedKnowledge(): ApprovedKnowledgeReader {
  const unavailable = async (): Promise<never> => {
    throw new KnowledgeTaskError("unavailable");
  };
  return { head: unavailable, current: unavailable, snapshot: unavailable };
}
