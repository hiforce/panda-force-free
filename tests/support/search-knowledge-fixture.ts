import type { SearchDocument } from "../../src/shared/search/contracts.js";
import type { ApprovedKnowledgeValue } from "../../src/shared/knowledge/catalog.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";

/** A port fixture preserves distinct knowledge identity and real evidence/version formats. */
export function approvedSearchKnowledge(documents: SearchDocument[], id = "knowledge"): ApprovedKnowledgeValue {
  const evidence = documents.map((document) => ({
      id: document.id,
      version: document.version,
      title: document.title,
      kind: "asset" as const,
      text: document.text,
      sections: [],
    })),
    first = evidence[0]!;
  const record: ApprovedKnowledgeValue["record"] = {
    schema: 1,
    id,
    version: "",
    previousVersion: null,
    taskId: "task-" + id,
    sourceCommit: "a".repeat(40),
    approvedAt: 1,
    approval: { mode: "manual" },
    sources: evidence.map(({ text: _text, sections: _sections, ...source }) => source),
    draft: validateKnowledgeEvidence(
      {
        schema: 1,
        title: "Approved knowledge",
        summary: "Reviewed knowledge with citations",
        claims: [
          {
            id: "claim",
            kind: "source",
            text: "Reviewed source material.",
            evidence: [{ sourceId: first.id, version: first.version, quote: first.text.slice(0, 40) }],
          },
        ],
        uncertainties: [],
      },
      evidence,
    ),
  };
  record.version = knowledgeRecordVersion(record);
  return {
    record,
    receipt: { id, version: record.version, commit: "b".repeat(40) },
    sources: documents.map((document) => ({
      id: document.id,
      version: document.version,
      blob: "c".repeat(40),
      title: document.title,
      path: document.path,
      ancestors: document.ancestors,
    })),
  };
}
