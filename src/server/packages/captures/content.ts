import type { SourceLimits } from "../../../shared/packages/sources/contracts.js";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { FilePackageContent } from "../content-store.js";
import { CapturedSourceCodec } from "./codec.js";

/** Only an authorized staging service should expose these immutable source files to callers. */
export class FileCapturedSources extends FilePackageContent<CapturedPackageSource> {
  constructor(root: string, limits?: SourceLimits, options?: { createDirectory?: boolean }) {
    super(root, new CapturedSourceCodec(limits), options);
  }
}
