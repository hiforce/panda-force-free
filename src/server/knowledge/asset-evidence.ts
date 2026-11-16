import type { KnowledgeRecord } from "../../shared/knowledge/tasks.js";
import type { KnowledgeEvidenceSource } from "../../shared/knowledge/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import { validateKnowledgeEvidence } from "./evidence.js";
import { KnowledgeTaskError } from "./tasks/contracts.js";

/** The frozen workflow validates user dialogue; each saved asset citation also remains verifiable independently. */
export function assertKnowledgeAssetEvidence(record: KnowledgeRecord, sources: KnowledgeEvidenceSource[]) {
  for (const claim of record.draft.claims) {
    const assetEvidence = claim.evidence.filter((evidence) => evidence.kind === "asset"),
      proof = validateKnowledgeEvidence(
        {
          schema: 1,
          title: record.draft.title,
          summary: "",
          claims: [
            {
              ...claim,
              kind: "inference",
              evidence: assetEvidence.map(({ sourceId, version, quote, start, section }) => ({
                sourceId,
                version,
                quote,
                start,
                ...(section === undefined ? {} : { section }),
              })),
            },
          ],
          uncertainties: [],
        },
        sources,
      ).claims[0]!.evidence;
    if (stableJson(proof) !== stableJson(assetEvidence)) throw new KnowledgeTaskError("conflict");
  }
}
