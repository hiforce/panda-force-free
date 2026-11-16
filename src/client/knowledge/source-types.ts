import type { SavedSourceKind } from "../../shared/content-sources/contracts.js";

export interface KnowledgeSourceChoice {
  id: string;
  title: string;
  kind: SavedSourceKind;
}
export interface KnowledgePanelContext {
  project: string;
  documents?: { id: string; title: string }[];
  sources?: KnowledgeSourceChoice[];
  selected: string[];
}
