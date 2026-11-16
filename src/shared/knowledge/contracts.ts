import type { SavedSourceBinding } from "../content-sources/contracts.js";
export type KnowledgeClaimKind = "source" | "inference" | "user";
export type KnowledgeEvidenceKind = "asset" | "user-input";

export interface KnowledgeEvidenceInput {
  sourceId: string;
  version: string;
  quote: string;
  section?: string;
  start?: number;
}

export interface KnowledgeClaimInput {
  id: string;
  kind: KnowledgeClaimKind;
  text: string;
  evidence: KnowledgeEvidenceInput[];
}

export interface KnowledgeDraftInput {
  schema: 1;
  title: string;
  summary: string;
  claims: KnowledgeClaimInput[];
  uncertainties: string[];
}

/** Frozen context lives in files; task ledgers retain only identities, versions and digests. */
export interface KnowledgeEvidenceSource {
  id: string;
  version: string;
  kind: KnowledgeEvidenceKind;
  binding?: SavedSourceBinding;
  title: string;
  text: string;
  sections: { id: string; start: number; end: number }[];
}

export interface KnowledgeEvidence {
  sourceId: string;
  version: string;
  kind: KnowledgeEvidenceKind;
  digest: string;
  start: number;
  end: number;
  quote: string;
  section?: string;
}

export interface KnowledgeDraft extends Omit<KnowledgeDraftInput, "claims"> {
  claims: (Omit<KnowledgeClaimInput, "evidence"> & { evidence: KnowledgeEvidence[] })[];
}

export class KnowledgeError extends Error {
  constructor(
    readonly code: "invalidInput" | "invalidEvidence" | "ambiguousEvidence" | "sourceChanged",
    readonly status = 400,
  ) {
    super(code);
  }
}
