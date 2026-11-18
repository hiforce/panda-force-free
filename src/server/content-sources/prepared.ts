import type { SavedSourceMetadata, SavedSourceText } from "../../shared/content-sources/contracts.js";
import type { CreativeAssetKind } from "../../shared/creative/assets.js";
import { extractCreativeText } from "../creative/assets/projection.js";

/** Captured native reads carry immutable references without retaining a project view or Git lease. */
export type PreparedSavedSource = { metadata: SavedSourceMetadata; bytes: number } & (
  | { text: Omit<SavedSourceText, "metadata"> }
  | { native: { kind: CreativeAssetKind; name: string; bytes: Uint8Array } }
  | { deferredNative: { kind: CreativeAssetKind; name: string; read(signal?: AbortSignal): Promise<Uint8Array> } }
);
export type SavedSourceParser = typeof extractCreativeText;

/** Remote bytes are verified outside the project lease; callers fence identity and access before returning results. */
export async function materializeSavedSource(
  value: PreparedSavedSource,
  signal?: AbortSignal,
  parse: SavedSourceParser = extractCreativeText,
): Promise<SavedSourceText> {
  const text =
    "deferredNative" in value
      ? await parse(
          value.deferredNative.kind,
          value.deferredNative.name,
          await value.deferredNative.read(signal),
          signal,
        )
      : "native" in value
        ? await parse(value.native.kind, value.native.name, value.native.bytes, signal)
        : value.text;
  return { metadata: structuredClone(value.metadata), text: text.text, sections: structuredClone(text.sections) };
}
