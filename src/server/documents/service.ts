import { ThemeSelectionError, type SiteThemeCatalog } from "../../shared/presentation/themes.js";
import type { DocumentIngestion } from "./ingestion/service.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DocumentRepository } from "./document-repository.js";
import type { SpaceRepository } from "./space-repository.js";
import type { DocumentSourceReader } from "./source-reader.js";
import { contentText, documentPath, expectedVersion, localeText, spaceInput, text } from "./validation.js";
import { DocumentError } from "./errors.js";
import { richDocumentInput } from "./rich-codec.js";
import { stableJson } from "../../shared/stable-json.js";
import type { RichDocumentBody } from "../../shared/documents/rich-body.js";

/** Application operations coordinate repositories without owning HTTP or engine execution. */
export class DocumentService {
  constructor(
    readonly spaces: SpaceRepository,
    readonly documents: DocumentRepository,
    readonly sources: DocumentSourceReader,
    private managedRoot: string,
    private requireProject: (id: string) => unknown,
    readonly ingestion: DocumentIngestion,
    readonly themes: SiteThemeCatalog,
  ) {}
  space(id: string) {
    const space = this.spaces.get(id);
    this.requireProject(space.projectId);
    return space;
  }
  listSpaces(projectId: string) {
    this.requireProject(text(projectId, 128));
    return this.spaces.list(projectId);
  }
  async createSpace(value: unknown) {
    const input = spaceInput(value);
    this.requireProject(input.projectId);
    this.validateTheme(input.theme, input.engine);
    const id = randomUUID();
    let root: string;
    if (input.sourceMode === "external") {
      const inspected = await this.sources.inspect(input.sourceRoot!);
      if (inspected.engine !== input.engine) throw new DocumentError("invalidInput");
      root = inspected.root;
    } else root = join(this.managedRoot, id, "source");
    // Create only the new managed directory; imported source roots stay read-only.
    if (input.sourceMode === "managed") mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      this.requireProject(input.projectId);
      return this.spaces.create(input, root, id);
    } catch (error) {
      if (input.sourceMode === "managed") rmSync(join(this.managedRoot, id), { recursive: true, force: true });
      throw error;
    }
  }
  private validateTheme(reference: string, engine: import("../../shared/documents/contracts.js").DocumentEngine) {
    try {
      return this.themes.validate(reference, engine);
    } catch (error) {
      if (error instanceof ThemeSelectionError) throw new DocumentError(error.code);
      throw error;
    }
  }
  updateTheme(id: string, value: Record<string, unknown>) {
    const space = this.spaces.get(id);
    this.requireProject(space.projectId);
    const theme = this.validateTheme(text(value.theme, 100), space.engine);
    return this.spaces.setTheme(id, theme, expectedVersion(value.version));
  }
  async importSource(spaceId: string) {
    return this.ingestion.importSpace(spaceId);
  }

  listDocuments(spaceId: string, search: string, offset: number) {
    const space = this.spaces.get(spaceId);
    this.requireProject(space.projectId);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DocumentError("invalidInput");
    return this.documents.list(spaceId, search, offset);
  }
  /** Lightweight authorized metadata for polling and workflow guards; never hydrate rich bodies here. */
  record(id: string) {
    if (this.documents.isTrashed(id)) throw new DocumentError("notFound", 404);
    const record = this.documents.record(id);
    const space = this.spaces.get(record.spaceId);
    this.requireProject(space.projectId);
    return record;
  }
  detail(id: string) {
    const record = this.record(id),
      detail = this.documents.get(id),
      space = this.spaces.get(record.spaceId);
    return { ...detail, engine: space.engine, sourceMode: space.sourceMode };
  }
  createDocument(value: Record<string, unknown>) {
    const spaceId = text(value.spaceId, 128),
      space = this.spaces.get(spaceId);
    this.requireProject(space.projectId);
    const created = this.documents.create(spaceId, documentPath(value.path), {
      title: text(value.title, 200),
      locale: localeText(value.locale),
      ...(value.body !== undefined ? richDocumentInput(value.body) : { content: contentText(value.content) }),
    });
    return { ...created, engine: space.engine, sourceMode: space.sourceMode };
  }
  saveDocument(id: string, value: Record<string, unknown>) {
    const current = this.detail(id);
    const input: { title: string; locale: string; content: string; body?: RichDocumentBody } = {
      title: text(value.title, 200),
      locale: localeText(value.locale),
      ...(value.body !== undefined ? richDocumentInput(value.body) : { content: contentText(value.content) }),
    };
    let resources;
    if (value.restoreRevisionId !== undefined) {
      const original = this.documents.revision(id, text(value.restoreRevisionId, 128));
      if (original.title !== input.title || original.locale !== input.locale || original.content !== input.content)
        throw new DocumentError("invalidInput");
      if (value.body !== undefined && stableJson(input.body) !== stableJson(original.body))
        throw new DocumentError("invalidRichBody");
      input.body = original.body;
      resources = original.resources || [];
    } else if (current.revision.body && value.body === undefined) {
      throw new DocumentError("invalidRichBody");
    }
    const saved = this.documents.save(id, expectedVersion(value.revision), input, undefined, resources);
    return { ...saved, engine: current.engine, sourceMode: current.sourceMode };
  }
  /** A navigation rename preserves the exact stored body, Markdown projection and resource bindings. */
  renameDocument(id: string, title: string, revision: number) {
    title = text(title, 200);
    revision = expectedVersion(revision);
    const current = this.detail(id);
    if (current.document.revision !== revision) throw new DocumentError("conflict", 409);
    if (current.document.title === title) return current;
    const saved = this.documents.save(id, revision, {
      title,
      locale: current.revision.locale,
      content: current.revision.content,
      body: current.revision.body,
    });
    return { ...saved, engine: current.engine, sourceMode: current.sourceMode };
  }
}
