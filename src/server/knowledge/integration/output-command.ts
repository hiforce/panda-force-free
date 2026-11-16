import type { KnowledgeTaskInput, KnowledgeRecord } from "../../../shared/knowledge/tasks.js";
import { stableJson } from "../../../shared/stable-json.js";
import { documentAuthor } from "../../documents/files/commands.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { assertKnowledgeAssetEvidence } from "../asset-evidence.js";

/** The immutable approved record binds both a new write and an exact receipt-only recovery. */
export function knowledgeOutputCommand(owner: string, input: KnowledgeTaskInput, record: KnowledgeRecord) {
  if (
    record.id !== input.target.id ||
    record.previousVersion !== input.target.expectedVersion ||
    record.sourceCommit !== input.sourceCommit
  )
    throw new KnowledgeTaskError("conflict");
  const sources = input.sources.map(({ text: _text, sections: _sections, ...metadata }) => metadata);
  if (stableJson(record.sources.filter((source) => source.kind === "asset")) !== stableJson(sources))
    throw new KnowledgeTaskError("conflict");
  assertKnowledgeAssetEvidence(record, input.sources);
  return {
    operationId: record.taskId,
    author: documentAuthor(owner),
    message: "Save approved knowledge result",
    intent: stableJson({ schema: 1, kind: "knowledge", owner, id: record.id, version: record.version }),
  };
}
