import type { ApplicationImageProvider } from "../../../engines/application-tools/runtime-port.js";
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
interface ImageRenderArtifact {
  digest: string;
  size: number;
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
}
export type ImageRenderReceipt = ImageRenderArtifact &
  (
    | { threadId: string; turnId: string }
    | { provider: ApplicationImageProvider | "media-executor"; invocationId?: string }
  );
export type ImageRenderResult = ImageRenderReceipt & { bytes: Buffer };
