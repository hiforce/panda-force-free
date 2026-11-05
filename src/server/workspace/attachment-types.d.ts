import type { Readable } from "node:stream";
export interface AttachmentMetadata {
  id: string;
  name: string;
  kind: string;
  contentType: string;
}
export interface AttachmentLocation {
  storage: string;
  objectKey: string;
  url: string;
}
export interface AttachmentStorage {
  put(bytes: Buffer, metadata: AttachmentMetadata): Promise<AttachmentLocation>;
}
export interface OssObjectClient {
  put(key: string, bytes: Buffer, options: { mime: string; headers: Record<string, string> }): Promise<unknown>;
  signatureUrlV4(method: string, expires: number, headers: undefined, key: string): Promise<string>;
  getStream(
    key: string,
    options: { timeout: number },
  ): Promise<{ stream: Readable; res?: { headers: Record<string, string | number> } }>;
}
