import type { SavedSourceKind, SavedSourceMetadata } from "./contracts.js";
import { savedSourceUrl } from "./links.js";

export interface SavedSourceSummary {
  id: string;
  version: string;
  kind: SavedSourceKind;
  title: string;
  locale: string;
  path: string;
  updatedAt: number;
  url: string;
}
export interface SavedSourcePage {
  head: string;
  sources: SavedSourceSummary[];
  total: number;
  nextOffset: number | null;
}
export function savedSourceSummary(project: string, row: SavedSourceMetadata): SavedSourceSummary {
  return {
    id: row.id,
    version: row.version,
    kind: row.binding.kind,
    title: row.title,
    locale: row.locale,
    path: row.path,
    updatedAt: row.updatedAt,
    url: savedSourceUrl(project, row.id, row.binding.kind, row.version),
  };
}
