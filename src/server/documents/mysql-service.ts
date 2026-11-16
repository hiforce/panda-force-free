import type { MetadataStore } from "../../shared/async-value.js";
import { ThemeSelectionError, type SiteThemeCatalog } from "../../shared/presentation/themes.js";
import type { MySQLDocumentIngestion } from "./ingestion/mysql-service.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MySQLDocumentRepository } from "./mysql-document-repository.js";
import type { MySQLSpaceRepository } from "./mysql-space-repository.js";
import type { DocumentSourceReader } from "./source-reader.js";
import { contentText, documentPath, expectedVersion, localeText, spaceInput, text } from "./validation.js";
import { DocumentError } from "./errors.js";
import { richDocumentInput } from "./rich-codec.js";
import { stableJson } from "../../shared/stable-json.js";
import type { RichDocumentBody } from "../../shared/documents/rich-body.js";
/** Application operations coordinate repositories without owning HTTP or engine execution. */
export class MySQLDocumentService {
  constructor(
    readonly spaces: MySQLSpaceRepository,
    readonly documents: MySQLDocumentRepository,
    readonly sources: DocumentSourceReader,
    private managedRoot: string,
    private requireProject: (id: string) => unknown,
    readonly ingestion: MySQLDocumentIngestion,
    readonly themes: MetadataStore<SiteThemeCatalog>,
  ) {}
  async space(id: string) {
    const space = await this.spaces.get(id);
    await this.requireProject(space.projectId);
    return space;
  }
  async listSpaces(projectId: string) {
    await this.requireProject(text(projectId, 128));
    return await this.spaces.list(projectId);
  }
  async createSpace(value: unknown) {
    const input = spaceInput(value);
    await this.requireProject(input.projectId);
    await this.validateTheme(input.theme, input.engine);
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
      await this.requireProject(input.projectId);
      return await this.spaces.create(input, root, id);
    } catch (error) {
      if (input.sourceMode === "managed") rmSync(join(this.managedRoot, id), { recursive: true, force: true });
      throw error;
    }
  }
  private async validateTheme(reference: string, engine: import("../../shared/documents/contracts.js").DocumentEngine) {
    try {
      return await this.themes.validate(reference, engine);
    } catch (error) {
      if (error instanceof ThemeSelectionError) throw new DocumentError(error.code);
      throw error;
    }
  }
  async updateTheme(id: string, value: Record<string, unknown>) {
    const space = await this.spaces.get(id);
    await this.requireProject(space.projectId);
    const theme = await this.validateTheme(text(value.theme, 100), space.engine);
    return await this.spaces.setTheme(id, theme, expectedVersion(value.version));
  }
  async importSource(spaceId: string) {
    return await this.ingestion.importSpace(spaceId);
  }
  async listDocuments(spaceId: string, search: string, offset: number) {
    const space = await this.spaces.get(spaceId);
    await this.requireProject(space.projectId);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DocumentError("invalidInput");
    return await this.documents.list(spaceId, search, offset);
  }
  /** Lightweight authorized metadata for polling and workflow guards; never hydrate rich bodies here. */
  async record(id: string) {
    if (await this.documents.isTrashed(id)) throw new DocumentError("notFound", 404);
    const record = await this.documents.record(id);
    const space = await this.spaces.get(record.spaceId);
    await this.requireProject(space.projectId);
    return record;
  }
  async detail(id: string) {
    const record = await this.record(id),
      detail = await this.documents.get(id),
      space = await this.spaces.get(record.spaceId);
    return { ...detail, engine: space.engine, sourceMode: space.sourceMode };
  }
  async createDocument(value: Record<string, unknown>) {
    const spaceId = text(value.spaceId, 128),
      space = await this.spaces.get(spaceId);
    await this.requireProject(space.projectId);
    const created = await this.documents.create(spaceId, documentPath(value.path), {
      title: text(value.title, 200),
      locale: localeText(value.locale),
      ...(value.body !== undefined ? richDocumentInput(value.body) : { content: contentText(value.content) }),
    });
    return { ...created, engine: space.engine, sourceMode: space.sourceMode };
  }
  async saveDocument(id: string, value: Record<string, unknown>) {
    const current = await this.detail(id);
    const input: {
      title: string;
      locale: string;
      content: string;
      body?: RichDocumentBody;
    } = {
      title: text(value.title, 200),
      locale: localeText(value.locale),
      ...(value.body !== undefined ? richDocumentInput(value.body) : { content: contentText(value.content) }),
    };
    let resources;
    if (value.restoreRevisionId !== undefined) {
      const original = await this.documents.revision(id, text(value.restoreRevisionId, 128));
      if (original.title !== input.title || original.locale !== input.locale || original.content !== input.content)
        throw new DocumentError("invalidInput");
      if (value.body !== undefined && stableJson(input.body) !== stableJson(original.body))
        throw new DocumentError("invalidRichBody");
      input.body = original.body;
      resources = original.resources || [];
    } else if (current.revision.body && value.body === undefined) {
      throw new DocumentError("invalidRichBody");
    }
    const saved = await this.documents.save(id, expectedVersion(value.revision), input, undefined, resources);
    return { ...saved, engine: current.engine, sourceMode: current.sourceMode };
  }
  /** A navigation rename preserves the exact stored body, Markdown projection and resource bindings. */
  async renameDocument(id: string, title: string, revision: number) {
    title = text(title, 200);
    revision = expectedVersion(revision);
    const current = await this.detail(id);
    if (current.document.revision !== revision) throw new DocumentError("conflict", 409);
    if (current.document.title === title) return current;
    const saved = await this.documents.save(id, revision, {
      title,
      locale: current.revision.locale,
      content: current.revision.content,
      body: current.revision.body,
    });
    return { ...saved, engine: current.engine, sourceMode: current.sourceMode };
  }
}
