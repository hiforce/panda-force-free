import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MySQLProjectLibraryRepository } from "./mysql-library-repository.js";
import type { MySQLDocumentService } from "./mysql-service.js";
import { localeText, text } from "./validation.js";
import { documentPath, expectedVersion } from "./validation.js";
import type { MySQLDocumentFolderRepository } from "./mysql-folder-repository.js";
import { DocumentError } from "./errors.js";
import { emptyRichBody } from "../../shared/documents/rich-body.js";
export function folderPath(value: unknown, root = false) {
  if (root && value === "") return "";
  const path = text(value, 480);
  if (path.split("/").length > 16) throw new DocumentError("invalidInput");
  documentPath(path + "/__folder__.md");
  return path;
}
/** Authoring starts from the project. Engine, theme and destination decisions belong to publication. */
export class MySQLProjectDocumentLibrary {
  constructor(
    private repository: MySQLProjectLibraryRepository,
    private documents: MySQLDocumentService,
    private managedRoot: string,
    private folders: MySQLDocumentFolderRepository,
  ) {}
  async get(projectId: string) {
    await this.documents.listSpaces(text(projectId, 128));
    return await this.repository.library(projectId);
  }
  async overview(projectId: string) {
    const library = await this.get(projectId);
    return { library, folders: library ? await this.folders.list(library.id) : [] };
  }
  async create(projectId: string, value: Record<string, unknown>) {
    const folder = folderPath(value.folder ?? "", true),
      title = text(value.title, 200),
      locale = localeText(value.locale);
    const library = await this.ensure(projectId, locale);
    if (folder) await this.folders.create(library.id, folder);
    return await this.documents.createDocument({
      spaceId: library.id,
      path: (folder ? folder + "/" : "") + randomUUID() + ".md",
      title,
      locale,
      body: emptyRichBody(),
    });
  }
  async createFolder(projectId: string, value: unknown) {
    const path = folderPath(value),
      library = await this.ensure(projectId, "en");
    return await this.folders.create(library.id, path);
  }
  async moveFolder(projectId: string, value: Record<string, unknown>) {
    const library = await this.get(projectId);
    if (!library) throw new DocumentError("notFound", 404);
    return await this.folders.move(
      library.id,
      folderPath(value.path),
      folderPath(value.next),
      expectedVersion(value.version),
    );
  }
  async removeFolder(projectId: string, value: Record<string, unknown>) {
    const library = await this.get(projectId);
    if (!library) throw new DocumentError("notFound", 404);
    return await this.folders.remove(library.id, folderPath(value.path), expectedVersion(value.version));
  }
  private async owned(projectId: string, id: unknown) {
    const library = await this.get(projectId);
    if (!library) throw new DocumentError("notFound", 404);
    const detail = await this.documents.documents.get(text(id, 128));
    if (detail.document.spaceId !== library.id) throw new DocumentError("notFound", 404);
    return detail;
  }
  async moveDocument(projectId: string, value: Record<string, unknown>) {
    const detail = await this.owned(projectId, value.id),
      folder = folderPath(value.folder ?? "", true);
    if (await this.documents.documents.isTrashed(detail.document.id)) throw new DocumentError("notFound", 404);
    await this.folders.moveDocument(
      detail.document.id,
      (folder ? folder + "/" : "") + detail.document.path.split("/").at(-1)!,
      expectedVersion(value.revision),
    );
    return await this.documents.detail(detail.document.id);
  }
  async trash(projectId: string, value: Record<string, unknown>) {
    const detail = await this.owned(projectId, value.id);
    await this.folders.trash(detail.document.id, expectedVersion(value.revision));
  }
  async restore(projectId: string, id: unknown) {
    const detail = await this.owned(projectId, id);
    await this.folders.restore(detail.document);
    return await this.documents.detail(detail.document.id);
  }
  async trashList(projectId: string) {
    const library = await this.get(projectId);
    return library ? await this.folders.trashList(library.id) : [];
  }
  async ensure(projectId: string, locale: string) {
    const existing = await this.get(projectId);
    if (existing) return existing;
    locale = localeText(locale);
    const id = randomUUID(),
      root = join(this.managedRoot, id, "source");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      const library = await this.repository.ensure(projectId, locale, id, root);
      if (library.id !== id) rmSync(join(this.managedRoot, id), { recursive: true, force: true });
      return library;
    } catch (error) {
      rmSync(join(this.managedRoot, id), { recursive: true, force: true });
      throw error;
    }
  }
}
