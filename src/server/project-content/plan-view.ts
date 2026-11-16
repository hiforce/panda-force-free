import type { ProjectContentView } from "./read-view.js";
import type { ProjectFileChange } from "./git/snapshot.js";
import { boundedFileReadLength, type ProjectFileReader } from "./file-reader.js";
import { contentChanges } from "./mutation.js";
import { projectDocumentId, projectFilePath } from "./paths.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { ProjectContentError } from "./errors.js";
import { projectBlobHash } from "./git/blob-hash.js";

/** Related planners see earlier validated changes without writing any working file or opening another project lease. */
export class ProjectContentPlan implements ProjectContentView {
  private staged = new Map<string, Buffer | null>();
  private bytes = 0;
  constructor(private readonly base: ProjectContentView) {}
  get commit() {
    this.assertHeld();
    return this.base.commit;
  }
  assertHeld() {
    this.base.assertHeld();
  }
  version(path: string): string | null {
    this.assertHeld();
    projectFilePath(path);
    if (!this.staged.has(path)) return this.base.version(path);
    const bytes = this.staged.get(path)!;
    return bytes === null ? null : projectBlobHash(bytes);
  }
  get paths(): readonly string[] {
    this.assertHeld();
    const paths = new Set(this.base.paths);
    for (const [path, value] of this.staged) {
      if (value === null) paths.delete(path);
      else paths.add(path);
    }
    if (paths.size > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
    return Object.freeze([...paths].sort());
  }
  apply(input: readonly ProjectFileChange[]) {
    this.assertHeld();
    const next = new Map(this.staged);
    for (const { path, content } of contentChanges(input)) {
      // A source may produce only one saved original per transaction; silently replacing it would lose a promised revision.
      if (next.has(path) && projectDocumentId(path) !== null) throw new ProjectContentError("conflict");
      next.set(path, content);
    }
    const validated = contentChanges([...next].map(([path, content]) => ({ path, content }))),
      paths = new Set(this.base.paths);
    for (const { path, content } of validated) {
      if (content === null) paths.delete(path);
      else paths.add(path);
    }
    if (paths.size > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
    this.staged = new Map(validated.map(({ path, content }) => [path, content]));
  }
  changes(): ProjectFileChange[] {
    this.assertHeld();
    return [...this.staged].map(([path, content]) => ({
      path,
      content: content === null ? null : Buffer.from(content),
    }));
  }
  private consume(size: number) {
    if (size > PROJECT_CONTENT_LIMITS.operationBytes - this.bytes) throw new ProjectContentError("invalidFile");
    this.bytes += size;
  }
  async read(path: string): Promise<Buffer | null> {
    this.assertHeld();
    projectFilePath(path);
    if (!this.staged.has(path)) {
      const value = await this.base.read(path);
      this.assertHeld();
      this.consume(value?.length ?? 0);
      return value;
    }
    const value = this.staged.get(path)!;
    this.consume(value?.length ?? 0);
    return value === null ? null : Buffer.from(value);
  }
  async inspect<T>(path: string, work: (file: ProjectFileReader) => Promise<T>): Promise<T> {
    this.assertHeld();
    projectFilePath(path);
    const staged = this.staged.has(path),
      bytes = this.staged.get(path);
    if (staged && bytes === null) throw new ProjectContentError("notFound");
    const inspect = async (file: ProjectFileReader) =>
      work(
        Object.freeze({
          size: file.size,
          read: async (offset: number, length: number) => {
            this.assertHeld();
            const requested = boundedFileReadLength(file.size, offset, length);
            this.consume(requested);
            const value = await file.read(offset, length);
            this.assertHeld();
            if (value.length > requested) throw new ProjectContentError("invalidFile");
            this.bytes -= requested - value.length;
            return value;
          },
        }),
      );
    const result = staged
      ? await inspect({
          size: bytes!.length,
          read: async (offset, length) => Buffer.from(bytes!.subarray(offset, offset + length)),
        })
      : await this.base.inspect(path, inspect);
    this.assertHeld();
    return result;
  }
}
