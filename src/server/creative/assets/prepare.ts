import type { CreativeAsset, CreativeAssetKind } from "../../../shared/creative/assets.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { fileChoice, fileDigest, fileLocale, fileText } from "../../project-content/codec-values.js";
import { projectContentId } from "../../project-content/paths.js";
import { DocumentError } from "../../documents/errors.js";
import { creativeAssetId, creativeDigest, creativeResourceName } from "./codec.js";
import { extractCreativeText } from "./projection.js";

export interface CreativeSaveInput {
  id: string;
  operationId: string;
  expectedVersion: string | null;
  kind: CreativeAssetKind;
  title: string;
  locale: string;
  name: string;
  bytes: Uint8Array;
  resources?: { name: string; bytes: Uint8Array }[];
}
/** Copy all mutable input before IO; neither a model nor a client may borrow another asset's digest. */
export function creativeSaveInput(input: CreativeSaveInput) {
  const kind = fileChoice(input.kind, ["slides", "web"]),
    id = creativeAssetId(input.id),
    operationId = projectContentId(input.operationId),
    expectedVersion = input.expectedVersion === null ? null : fileDigest(input.expectedVersion),
    title = fileText(input.title, 800),
    locale = fileLocale(input.locale),
    name = creativeResourceName(input.name);
  const copy = (bytes: Uint8Array, maximum: number, allowEmpty = false) => {
    if (!(bytes instanceof Uint8Array) || (!allowEmpty && !bytes.byteLength) || bytes.byteLength > maximum)
      throw new DocumentError("tooLarge", 413);
    return Buffer.from(bytes);
  };
  if (!Array.isArray(input.resources ?? []) || (input.resources?.length ?? 0) > limits.resources)
    throw new DocumentError("invalidInput");
  const bytes = copy(input.bytes, kind === "web" ? limits.htmlBytes : limits.sourceBytes),
    resources = (input.resources ?? []).map((r) => ({
      name: creativeResourceName(r.name),
      bytes: copy(r.bytes, limits.resourceBytes, true),
    })),
    names = [name, ...resources.map((r) => r.name)].map((n) => n.toLowerCase());
  if (
    new Set(names).size !== names.length ||
    bytes.length + resources.reduce((n, r) => n + r.bytes.length, 0) > limits.totalBytes ||
    !name.toLowerCase().endsWith(kind === "web" ? ".html" : ".pptx")
  )
    throw new DocumentError("invalidInput");
  return { id, operationId, expectedVersion, kind, title, locale, name, bytes, resources };
}
export type CreativePrepared = ReturnType<typeof creativeSaveInput>;
export async function validateCreativeOriginal(input: CreativePrepared, signal?: AbortSignal) {
  try {
    await extractCreativeText(input.kind, input.name, input.bytes, signal);
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError("invalidInput");
  }
}
export function creativeDescriptors(input: CreativePrepared): Pick<CreativeAsset, "source" | "resources"> {
  const resource = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, digest: creativeDigest(bytes) });
  return {
    source: resource(input.name, input.bytes),
    resources: input.resources.map((r) => resource(r.name, r.bytes)),
  };
}
