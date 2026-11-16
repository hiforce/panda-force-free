import type { SavedSourceMetadata, SavedSourceText } from "../../shared/content-sources/contracts.js";
import type { CreativeAssetKind } from "../../shared/creative/assets.js";
import { extractCreativeText } from "../creative/assets/projection.js";

/** Captured data carries no project view, lease, reader or authorization callback. */
export type PreparedSavedSource = { metadata: SavedSourceMetadata; bytes: number } & (
  { text: Omit<SavedSourceText, "metadata"> } | { native: { kind: CreativeAssetKind; name: string; bytes: Uint8Array } }
);
export type SavedSourceParser = typeof extractCreativeText;

/** Parsing is pure work; its caller must fence source identity and access before returning a result. */
export async function materializeSavedSource(
  value: PreparedSavedSource,
  signal?: AbortSignal,
  parse: SavedSourceParser = extractCreativeText,
): Promise<SavedSourceText> {
  const text =
    "native" in value ? await parse(value.native.kind, value.native.name, value.native.bytes, signal) : value.text;
  return { metadata: structuredClone(value.metadata), text: text.text, sections: structuredClone(text.sections) };
}
