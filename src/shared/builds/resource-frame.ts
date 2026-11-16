import { BuildError, BUILD_LIMITS } from "./validation.js";
import { ResourceBuildRequest, RESOURCE_BUILD_LIMITS } from "./resources.js";
import { ImmutableSourceTree } from "../packages/sources/tree.js";
import { SourceError, type SourceResource } from "../packages/sources/contracts.js";

export const RESOURCE_FRAME_MAGIC = new TextEncoder().encode("PFBLD02\n");
export const RESOURCE_FRAME_HEADER = 16;
export const RESOURCE_FRAME_INDEX = BUILD_LIMITS.inputBytes + 4 * 1024 * 1024;
export const RESOURCE_FRAME_MAX = RESOURCE_FRAME_HEADER + RESOURCE_FRAME_INDEX + RESOURCE_BUILD_LIMITS.totalBytes;
export const RESOURCE_FRAME_CONTENT_TYPE = "application/vnd.pandaforce.resource-build";
export const RESOURCE_FRAME_TIMEOUT_MS = 120000;

/** Length-prefixed raw resources avoid base64 expansion and admit no hidden payloads or filesystem links. */
export function encodeResourceBuild(value: ResourceBuildRequest): Uint8Array {
  if (!(value instanceof ResourceBuildRequest)) throw new BuildError("invalidResourceBuild");
  const index = new TextEncoder().encode(JSON.stringify(value.descriptor));
  if (index.length > RESOURCE_FRAME_INDEX) throw new BuildError("resourceBuildTooLarge", 413);
  const bytes = new Uint8Array(RESOURCE_FRAME_HEADER + index.length + value.tree.byteLength),
    view = new DataView(bytes.buffer);
  bytes.set(RESOURCE_FRAME_MAGIC);
  view.setUint32(8, index.length, false);
  view.setUint32(12, value.tree.byteLength, false);
  bytes.set(index, RESOURCE_FRAME_HEADER);
  let offset = RESOURCE_FRAME_HEADER + index.length;
  for (const file of value.tree.files) {
    bytes.set(value.tree.read(file.path), offset);
    offset += file.bytes;
  }
  return bytes;
}
export function resourceFrameSize(bytes: Uint8Array): number {
  if (bytes.length < RESOURCE_FRAME_HEADER || RESOURCE_FRAME_MAGIC.some((byte, i) => byte !== bytes[i]))
    throw new BuildError("invalidResourceBuild");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    index = view.getUint32(8, false),
    payload = view.getUint32(12, false);
  if (!index || index > RESOURCE_FRAME_INDEX || payload > RESOURCE_BUILD_LIMITS.totalBytes)
    throw new BuildError("resourceBuildTooLarge", 413);
  return RESOURCE_FRAME_HEADER + index + payload;
}
export async function decodeResourceBuild(input: Uint8Array): Promise<ResourceBuildRequest> {
  if (!(input instanceof Uint8Array) || input.length > RESOURCE_FRAME_MAX)
    throw new BuildError("resourceBuildTooLarge", 413);
  const bytes = new Uint8Array(input);
  if (resourceFrameSize(bytes) !== bytes.length) throw new BuildError("invalidResourceBuild");
  const size = new DataView(bytes.buffer).getUint32(8, false);
  let index: Record<string, unknown>;
  try {
    index = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(RESOURCE_FRAME_HEADER, RESOURCE_FRAME_HEADER + size),
      ),
    );
  } catch {
    throw new BuildError("invalidResourceBuild");
  }
  if (
    !index ||
    typeof index !== "object" ||
    Array.isArray(index) ||
    index.schema !== "panda.resource-build/v2" ||
    !Array.isArray(index.files) ||
    index.files.length > RESOURCE_BUILD_LIMITS.files
  )
    throw new BuildError("invalidResourceBuild");
  let offset = RESOURCE_FRAME_HEADER + size;
  const resources: SourceResource[] = index.files.map((file: unknown) => {
    if (
      !file ||
      typeof file !== "object" ||
      !("bytes" in file) ||
      !("path" in file) ||
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 0 ||
      Number(file.bytes) > RESOURCE_BUILD_LIMITS.fileBytes ||
      Number(file.bytes) > bytes.length - offset
    )
      throw new BuildError("invalidResourceBuild");
    const resource = { path: file.path as string, bytes: bytes.subarray(offset, offset + Number(file.bytes)) };
    offset += Number(file.bytes);
    return resource;
  });
  if (offset !== bytes.length) throw new BuildError("invalidResourceBuild");
  try {
    const tree = await ImmutableSourceTree.create(resources, RESOURCE_BUILD_LIMITS),
      request = await ResourceBuildRequest.create(index.input, index.theme, tree);
    if (JSON.stringify(request.descriptor) !== JSON.stringify(index)) throw new BuildError("inputDigestMismatch");
    return request;
  } catch (error) {
    if (error instanceof SourceError) throw new BuildError("invalidResourceBuild");
    throw error;
  }
}
