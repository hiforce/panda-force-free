import type { DocumentDetail, DocumentImportIssue, ImportResult } from "../../../shared/documents/contracts.js";
import type { DocumentSourceReader } from "../source-reader.js";
import type { SpaceRepository } from "../space-repository.js";
import type { DocumentImageIngestion, StagedImage } from "./images.js";
import type { DocumentIngestionRepository } from "./repository.js";
import { readSourceText } from "./files.js";
import { contentHash } from "../content-hash.js";
import { MAX_DOCUMENT_BYTES } from "../validation.js";
import { DocumentError } from "../errors.js";
import type { SourceImagePolicy } from "../source-profile/image-policy.js";

/** Owns read-only ingestion; staging IO completes before any source revision is committed. */
export class DocumentIngestion {
  private active = new Set<string>();
  constructor(
    private sources: DocumentSourceReader,
    private spaces: SpaceRepository,
    private images: DocumentImageIngestion,
    private repository: DocumentIngestionRepository,
    private requireProject: (id: string) => unknown,
    private detail: (id: string) => DocumentDetail,
    private imagePolicy: (space: string, locale: string, content: string) => SourceImagePolicy | undefined = () =>
      undefined,
  ) {}
  async importSpace(spaceId: string): Promise<ImportResult> {
    const space = this.spaces.get(spaceId);
    this.requireProject(space.projectId);
    if (space.sourceMode !== "external") throw new DocumentError("invalidInput");
    if (this.active.has(space.id)) throw new DocumentError("busy", 429);
    this.active.add(space.id);
    try {
      const scan = await this.sources.scan(space.sourceRoot, space.locale),
        budget = { bytes: 0 },
        staged = new Map<string, StagedImage[]>(),
        issues: DocumentImportIssue[] = [];
      let issuesTruncated = false;
      for (const document of scan.documents) {
        const result = await this.images.stage(
          scan.inspection.root,
          document.path,
          document.content,
          space.engine,
          budget,
          this.imagePolicy(space.id, document.locale, document.content),
        );
        staged.set(document.path, result.images);
        if (issues.length + result.issues.length > 200) issuesTruncated = true;
        issues.push(...result.issues.slice(0, 200 - issues.length));
      }
      await this.images.verify(scan.inspection.root, staged.values());
      // A source edit during image staging must not create a mixed revision.
      for (const document of scan.documents)
        if (
          contentHash(await readSourceText(scan.inspection.root, document.path, MAX_DOCUMENT_BYTES)) !== document.hash
        )
          throw new DocumentError("conflict", 409);
      this.requireProject(space.projectId);
      if ((await this.sources.root(space.sourceRoot)) !== scan.inspection.root)
        throw new DocumentError("conflict", 409);
      const result = this.repository.import(
        space.id,
        scan.documents,
        staged,
        !scan.truncated && !scan.skipped.length,
        space.version,
      );
      return {
        ...result,
        skipped: scan.skipped,
        truncated: scan.truncated,
        assets: { ...result.assets, issues, issuesTruncated },
      };
    } finally {
      this.active.delete(space.id);
    }
  }
  async importImages(id: string, expected: number) {
    const detail = this.detail(id),
      space = this.spaces.get(detail.document.spaceId);
    this.requireProject(space.projectId);
    if (space.sourceMode !== "external") throw new DocumentError("invalidInput");
    if (detail.document.revision !== expected) throw new DocumentError("conflict", 409);
    const root = await this.sources.root(space.sourceRoot);
    const staged = await this.images.stage(
      root,
      detail.document.path,
      detail.revision.content,
      space.engine,
      {
        bytes: 0,
      },
      this.imagePolicy(space.id, detail.revision.locale, detail.revision.content),
    );
    await this.images.verify(root, [staged.images]);
    this.detail(id);
    this.requireProject(space.projectId);
    if ((await this.sources.root(space.sourceRoot)) !== root) throw new DocumentError("conflict", 409);
    const result = this.repository.update(id, expected, staged.images, space.version);
    return {
      ...result,
      detail: { ...result.detail, engine: space.engine, sourceMode: space.sourceMode },
      issues: staged.issues,
    };
  }
}
