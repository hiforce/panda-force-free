import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { ProjectContentError } from "./errors.js";
import { projectBlobHash } from "./git/blob-hash.js";
import type { ProjectGitLease } from "./git/lease.js";
import { projectFilePath } from "./paths.js";
import { isMissingFile, type ProjectWorkingFiles } from "./working-files.js";
import { boundedFileReadLength, type ProjectFileReader } from "./file-reader.js";

/** Domain readers accept a scoped snapshot, including validated staged metadata in a combined transaction. */
export interface ProjectContentView {
  readonly commit: string;
  readonly paths: readonly string[];
  assertHeld(): void;
  version(path: string): string | null;
  read(path: string): Promise<Buffer | null>;
  inspect<T>(path: string, work: (file: ProjectFileReader) => Promise<T>): Promise<T>;
}

/** One scoped read view freezes tracked paths while file reads remain authoritative and bounded. */
export class ProjectContentReadView implements ProjectContentView {
  private active = true;
  private bytes = 0;
  readonly paths: readonly string[];
  constructor(
    readonly commit: string,
    private readonly entries: ReadonlyMap<string, string>,
    private readonly files: ProjectWorkingFiles,
    private readonly lease: ProjectGitLease,
  ) {
    this.paths = Object.freeze([...entries.keys()]);
  }

  private assertActive() {
    if (!this.active) throw new ProjectContentError("unavailable");
    this.lease.assertHeld();
  }
  /** Mutable state writers may fence a replacement with this guard only during the owning coordinator callback. */
  assertHeld(): void {
    this.assertActive();
  }
  /** An opaque saved-file identity can describe a projection without reading its original bytes. */
  version(path: string): string | null {
    this.assertActive();
    projectFilePath(path);
    return this.entries.get(path) ?? null;
  }
  private consume(bytes: number) {
    if (bytes > PROJECT_CONTENT_LIMITS.operationBytes - this.bytes) throw new ProjectContentError("invalidFile");
    this.bytes += bytes;
  }

  async read(path: string): Promise<Buffer | null> {
    this.assertActive();
    projectFilePath(path);
    try {
      const result = await this.files.inspect(path, async (file) => {
        if (!this.entries.has(path)) throw new ProjectContentError("conflict");
        this.consume(file.size);
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < file.size;) {
          this.assertActive();
          const bytes = await file.read(offset, Math.min(65536, file.size - offset));
          if (!bytes.length) throw new ProjectContentError("conflict");
          chunks.push(bytes);
          offset += bytes.length;
        }
        const bytes = Buffer.concat(chunks, file.size);
        if (projectBlobHash(bytes) !== this.entries.get(path)) throw new ProjectContentError("conflict");
        this.assertActive();
        return bytes;
      });
      this.assertActive();
      return result;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.assertActive();
      if (this.entries.has(path)) throw new ProjectContentError("conflict");
      return null;
    }
  }

  async inspect<T>(path: string, work: (file: ProjectFileReader) => Promise<T>): Promise<T> {
    this.assertActive();
    projectFilePath(path);
    if (!this.entries.has(path)) throw new ProjectContentError("notFound");
    const result = await this.files
      .inspect(path, (file) =>
        work(
          Object.freeze({
            size: file.size,
            read: async (offset: number, length: number) => {
              this.assertActive();
              const requested = boundedFileReadLength(file.size, offset, length);
              this.consume(requested);
              const bytes = await file.read(offset, length);
              this.bytes -= requested - bytes.length;
              this.assertActive();
              return bytes;
            },
          }),
        ),
      )
      .catch((error) => {
        if (isMissingFile(error)) throw new ProjectContentError("conflict");
        throw error;
      });
    this.assertActive();
    return result;
  }
  close(): void {
    this.active = false;
  }
}
