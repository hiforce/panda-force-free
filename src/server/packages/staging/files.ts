import { SourceStageError, type SourceStageRequest } from "../../../shared/packages/stages/contracts.js";
import { stageId } from "../../../shared/packages/stages/input.js";
import { sourceLimits, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { FileCapturedSources } from "../captures/content.js";
import { CapturedSourceCodec } from "../captures/codec.js";
import type { SourceStageFiles } from "./ports.js";
import type { SourceNamespaceActivity } from "./activity.js";
import type { SourceUploadBody, SourceUploadIdentity } from "../uploads/contracts.js";
import { writeSourceUpload, readSourceUpload, recoverSourceUpload, dropSourceUpload } from "../uploads/files.js";
import { OwnedContentDirectories } from "../content-directories.js";

/** A namespace is created once before acquisition; a late writer can never recreate a removed namespace. */
export class FileSourceStageNamespaces implements SourceStageFiles {
  private directories: OwnedContentDirectories;
  constructor(
    root: string,
    private activity: SourceNamespaceActivity,
  ) {
    this.directories = new OwnedContentDirectories(root, () => new SourceStageError("stageUnavailable"));
  }
  private path(id: string): string {
    return this.directories.path(stageId(id));
  }
  reserve(request: SourceStageRequest, options: SourceLimits): number {
    const limits = sourceLimits(options),
      codec = new CapturedSourceCodec(limits);
    return request.source.kind === "zip-upload"
      ? codec.maxBytes + request.source.bytes
      : codec.maxBytes - limits.archiveBytes;
  }
  size(source: CapturedPackageSource): number {
    return (
      12 +
      new TextEncoder().encode(JSON.stringify(source.descriptor)).byteLength +
      source.tree.byteLength +
      (source.links?.byteLength ?? 0) +
      source.descriptor.archiveBytes
    );
  }
  prepare(id: string): void {
    this.directories.prepare(stageId(id));
  }
  private content(id: string, limits: SourceLimits) {
    return new FileCapturedSources(this.path(id), limits, { createDirectory: false });
  }
  put(id: string, source: CapturedPackageSource, options: SourceLimits) {
    stageId(id);
    const limits = sourceLimits(options);
    return this.activity.write(id, () => this.content(id, limits).put(source));
  }
  read(id: string, digest: string, options: SourceLimits) {
    stageId(id);
    const limits = sourceLimits(options);
    return this.activity.read(id, () => this.content(id, limits).read(digest));
  }
  async recover(id: string, digest: string, options: SourceLimits) {
    stageId(id);
    const limits = sourceLimits(options);
    return this.activity.read(id, async () => {
      const source = await this.content(id, limits).read(digest);
      await this.directories.sync(id);
      return source;
    });
  }
  async remove(id: string): Promise<void> {
    stageId(id);
    await this.activity.remove(id, async () => {
      await this.directories.remove(id);
    });
  }
  upload(id: string, expected: SourceUploadIdentity, body: SourceUploadBody, signal: AbortSignal) {
    stageId(id);
    return this.activity.write(id, () => writeSourceUpload(this.path(id), expected, body, signal));
  }
  original(id: string, expected: SourceUploadIdentity, signal: AbortSignal) {
    stageId(id);
    return this.activity.read(id, () => readSourceUpload(this.path(id), expected, signal));
  }
  recoverOriginal(id: string, expected: SourceUploadIdentity, signal: AbortSignal) {
    stageId(id);
    return this.activity.read(id, () => recoverSourceUpload(this.path(id), expected, signal));
  }
  dropOriginal(id: string) {
    stageId(id);
    return this.activity.remove(id, () => dropSourceUpload(this.path(id)));
  }
}
