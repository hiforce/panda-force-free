import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProjectLibraryRepository } from "./library-repository.js";
import type { DocumentService } from "./service.js";
import { localeText, text } from "./validation.js";
import { documentPath, expectedVersion } from "./validation.js";
import type { DocumentFolderRepository } from "./folder-repository.js";
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
export class ProjectDocumentLibrary {
  constructor(
    private repository: ProjectLibraryRepository,
    private documents: DocumentService,
    private managedRoot: string,
    private folders: DocumentFolderRepository,
  ) {}
  get(projectId: string) {
    this.documents.listSpaces(text(projectId, 128));
    return this.repository.library(projectId);
  }
  overview(projectId: string) {
    const library = this.get(projectId);
    return { library, folders: library ? this.folders.list(library.id) : [] };
  }
  create(projectId: string, value: Record<string, unknown>) {
    const folder = folderPath(value.folder ?? "", true),
      title = text(value.title, 200),
      locale = localeText(value.locale);
    const library = this.ensure(projectId, locale);
    if (folder) this.folders.create(library.id, folder);
    return this.documents.createDocument({
      spaceId: library.id,
      path: (folder ? folder + "/" : "") + randomUUID() + ".md",
      title,
      locale,
      body: emptyRichBody(),
    });
  }
  createFolder(projectId: string, value: unknown) {
    const path = folderPath(value),
      library = this.ensure(projectId, "en");
    return this.folders.create(library.id, path);
  }
  moveFolder(projectId: string, value: Record<string, unknown>) {
    const library = this.get(projectId);
    if (!library) throw new DocumentError("notFound", 404);
    return this.folders.move(
      library.id,
      folderPath(value.path),
      folderPath(value.next),
      expectedVersion(value.version),
    );
  }
  removeFolder(projectId: string, value: Record<string, unknown>) {
    const library = this.get(projectId);
    if (!library) throw new DocumentError("notFound", 404);
    return this.folders.remove(library.id, folderPath(value.path), expectedVersion(value.version));
  }
  private owned(projectId: string, id: unknown) {
    const library = this.get(projectId);
    if (!library) throw new DocumentError("notFound", 404);
    const detail = this.documents.documents.get(text(id, 128));
    if (detail.document.spaceId !== library.id) throw new DocumentError("notFound", 404);
    return detail;
  }
  moveDocument(projectId: string, value: Record<string, unknown>) {
    const detail = this.owned(projectId, value.id),
      folder = folderPath(value.folder ?? "", true);
    if (this.documents.documents.isTrashed(detail.document.id)) throw new DocumentError("notFound", 404);
    this.folders.moveDocument(
      detail.document.id,
      (folder ? folder + "/" : "") + detail.document.path.split("/").at(-1)!,
      expectedVersion(value.revision),
    );
    return this.documents.detail(detail.document.id);
  }
  trash(projectId: string, value: Record<string, unknown>) {
    const detail = this.owned(projectId, value.id);
    this.folders.trash(detail.document.id, expectedVersion(value.revision));
  }
  restore(projectId: string, id: unknown) {
    const detail = this.owned(projectId, id);
    this.folders.restore(detail.document);
    return this.documents.detail(detail.document.id);
  }
  trashList(projectId: string) {
    const library = this.get(projectId);
    return library ? this.folders.trashList(library.id) : [];
  }
  ensure(projectId: string, locale: string) {
    const existing = this.get(projectId);
    if (existing) return existing;
    locale = localeText(locale);
    const id = randomUUID(),
      root = join(this.managedRoot, id, "source");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      const library = this.repository.ensure(projectId, locale, id, root);
      if (library.id !== id) rmSync(join(this.managedRoot, id), { recursive: true, force: true });
      return library;
    } catch (error) {
      rmSync(join(this.managedRoot, id), { recursive: true, force: true });
      throw error;
    }
  }
}
