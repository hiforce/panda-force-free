import type { CreationEngineProfile } from "../../../../shared/creation/contracts.js";

export class ImageRenderError extends Error {
  constructor(readonly code: "invalidInput" | "conflict" | "unavailable" | "uncertain" | "invalidResult" | "busy") {
    super(code);
    this.name = "ImageRenderError";
  }
}
/** The caller supplies already-authorized bytes, never engine-visible paths or private asset identifiers. */
export interface ImageRenderRequest {
  owner: string;
  taskId: string;
  contextDigest: string;
  slot: number;
  prompt: string;
  profile: CreationEngineProfile;
  images?: readonly Uint8Array[];
}
export interface ImageRenderIntent {
  schema: 1;
  key: string;
  signature: string;
  owner: string;
  taskId: string;
  contextDigest: string;
  slot: number;
  prompt: string;
  profile: CreationEngineProfile;
  inputs: { digest: string; mime: string }[];
}
export interface ImageRenderBinding {
  threadId: string;
  directory: string;
}
export interface ImageRenderReceipt {
  digest: string;
  size: number;
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
  threadId: string;
  turnId: string;
}
export interface ImageRenderResult extends ImageRenderReceipt {
  bytes: Buffer;
}
