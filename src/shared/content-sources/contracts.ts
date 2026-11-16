/** Original kinds describe saved works, independently of installed skills and derived knowledge. */
export type SavedSourceKind = "document" | "web" | "slides";
export const SAVED_SOURCE_LIMITS = Object.freeze({
  entries: 10000,
  selected: 1000,
  metadataBytes: 16 * 1024 * 1024,
  textBytes: 32 * 1024 * 1024,
});

export interface SavedSourceResource {
  name: string;
  digest: string;
  size: number;
}
export interface SavedSourceBinding {
  kind: SavedSourceKind;
  path: string;
  blob: string;
  original?: SavedSourceResource;
  resources?: SavedSourceResource[];
}
export interface SavedSourceMetadata {
  id: string;
  version: string;
  title: string;
  locale: string;
  path: string;
  updatedAt: number;
  ancestors: string[];
  binding: SavedSourceBinding;
}
export interface SavedSourceText {
  metadata: SavedSourceMetadata;
  text: string;
  sections: { id: string; start: number; end: number }[];
}
