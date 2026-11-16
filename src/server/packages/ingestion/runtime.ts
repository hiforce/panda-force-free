import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { SourceStageView } from "../../../shared/packages/stages/contracts.js";

export interface SourceRuntimeLimits {
  readonly bytes: number;
  readonly parallel: number;
}
export interface SourceRuntimeLease {
  release(): void;
}
export const SOURCE_UPLOAD_RUNTIME_BYTES = 4 * 1024 * 1024;

/** Runtime allocations are distinct from durable disk reservations and contain no task status authority. */
export class SourceRuntime {
  readonly limits: SourceRuntimeLimits;
  private bytes = 0;
  private active = 0;
  constructor(options?: SourceRuntimeLimits) {
    this.limits = Object.freeze({ ...(options ?? { bytes: 1024 * 1024 * 1024, parallel: 2 }) });
    if (
      Object.keys(this.limits).length !== 2 ||
      Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)
    )
      throw new SourceError("invalidSource");
  }
  acquire(bytes: number): SourceRuntimeLease | null {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new SourceError("invalidSource");
    if (bytes > this.limits.bytes) throw new SourceError("sourceTooLarge");
    if (this.active >= this.limits.parallel || bytes > this.limits.bytes - this.bytes) return null;
    this.bytes += bytes;
    this.active++;
    let held = true;
    return {
      release: () => {
        if (held) {
          held = false;
          this.bytes -= bytes;
          this.active--;
        }
      },
    };
  }
  snapshot() {
    return Object.freeze({ active: this.active, bytes: this.bytes });
  }
}
export function sourceCaptureBytes(stage: SourceStageView): number {
  if (stage.request.source.kind === "github" && stage.request.selected?.length === 0) return 128 * 1024 * 1024;
  const archive = stage.request.source.kind === "zip-upload" ? stage.request.source.bytes : stage.limits.archiveBytes;
  // Capture, verification and immutable encoding temporarily own several independent copies.
  const bytes = stage.limits.totalBytes * 8 + archive * 6 + 128 * 1024 * 1024;
  if (!Number.isSafeInteger(bytes)) throw new SourceError("sourceTooLarge");
  return bytes;
}
