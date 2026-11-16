import { randomUUID } from "node:crypto";
import { emptyRichBody } from "../../../shared/documents/rich-body.js";
import {
  DOCUMENT_TREE_LIMITS,
  documentSubtree,
  moveDocumentTree,
  validateDocumentTree,
  type DocumentTreeMutation,
  type DocumentTreeReceipt,
  type ProjectDocumentTree,
} from "../../../shared/documents/navigation.js";
import type { DocumentSpace } from "../../../shared/documents/contracts.js";
import type { ProjectDocumentLibrary } from "../library-service.js";
import type { DocumentService } from "../service.js";
import { richDocumentInput } from "../rich-codec.js";
import { expectedVersion, localeText, text } from "../validation.js";
import { DocumentError } from "../errors.js";
import type { DocumentNavigationRepository } from "./repository.js";
import { DocumentNavigationBootstrap } from "./bootstrap.js";
import { navigationGuard, navigationInput, navigationRequest, navigationTarget } from "./validation.js";
import { insertTreeNodes, liftRemovedNodes } from "../../../shared/documents/navigation-structure.js";
import { planTreeRestore } from "../../../shared/documents/navigation-restoration.js";
import type { DocumentCreationSource } from "../creation-port.js";

type Command = ReturnType<typeof navigationInput>;
type Outcome = Pick<DocumentTreeReceipt, "documentId" | "affectedDocumentIds" | "restoredToRoot">;

/** Manual UI and agent tools share one authorized, versioned and replay-safe navigation application. */
export class ProjectDocumentNavigation {
  private bootstrap: DocumentNavigationBootstrap;
  constructor(
    private repository: DocumentNavigationRepository,
    private library: ProjectDocumentLibrary,
    private documents: DocumentService,
  ) {
    this.bootstrap = new DocumentNavigationBootstrap(repository, library, documents);
  }
  tree(projectId: string): ProjectDocumentTree {
    projectId = text(projectId, 128);
    return this.repository.transaction(() => {
      const space = this.bootstrap.ensure(projectId);
      return space ? this.snapshot(projectId, space.id) : { projectId, version: 0, nodes: [] };
    });
  }
  trashList(projectId: string) {
    return this.trashPage(projectId).documents;
  }
  trashPage(projectId: string, cursor?: string) {
    projectId = text(projectId, 128);
    let after: { deletedAt: number; documentId: string } | null = null;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error("Invalid cursor");
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid cursor");
        const fields = value as Record<string, unknown>;
        if (Object.keys(fields).length !== 2 || !Number.isSafeInteger(fields.deletedAt) || Number(fields.deletedAt) < 0)
          throw Error("Invalid cursor");
        after = { deletedAt: Number(fields.deletedAt), documentId: text(fields.documentId, 128) };
      } catch {
        throw new DocumentError("invalidInput");
      }
    }
    return this.repository.transaction(() => {
      const space = this.bootstrap.ensure(projectId);
      return space ? this.repository.trashPage(space.id, after) : { documents: [], nextCursor: null };
    });
  }
  create(owner: string, value: unknown): DocumentTreeMutation {
    return this.createDocument(owner, value);
  }
  async createFromSource(
    owner: string,
    value: unknown,
    source: DocumentCreationSource,
    authorize?: () => void | Promise<void>,
  ) {
    return this.sourceDocument(owner, value, source, false, authorize);
  }
  async appendFromSource(
    owner: string,
    value: unknown,
    source: DocumentCreationSource,
    authorize?: () => void | Promise<void>,
  ) {
    return this.sourceDocument(owner, value, source, true, authorize);
  }
  private async sourceDocument(
    owner: string,
    value: unknown,
    source: DocumentCreationSource,
    append: boolean,
    authorize?: () => void | Promise<void>,
  ) {
    await authorize?.();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocumentError("invalidInput");
    const fields = { ...(value as Record<string, unknown>) };
    let minimum: number | undefined;
    if (append) {
      if (Object.hasOwn(fields, "treeVersion")) throw new DocumentError("invalidInput");
      const version = fields.minimumTreeVersion ?? 0;
      if (!Number.isSafeInteger(version) || Number(version) < 0) throw new DocumentError("invalidInput");
      minimum = Number(version);
      delete fields.minimumTreeVersion;
      fields.treeVersion = 0;
    }
    if (Object.hasOwn(fields, "body")) throw new DocumentError("invalidInput");
    const identity = text(source.identity, 1000),
      command = navigationInput(fields, ["parentId", "title", "locale"]),
      request = navigationRequest({
        kind: "create",
        id: command.id,
        projectId: command.projectId,
        version: minimum ?? command.version,
        parentId: fields.parentId === null || fields.parentId === undefined ? null : text(fields.parentId, 128),
        title: text(fields.title, 200),
        locale: localeText(fields.locale),
        source: identity,
        ...(minimum === undefined ? {} : { append: true }),
      });
    const replay = this.repository.transaction(() => {
      const space = this.library.get(command.projectId);
      if (!space) return null;
      const previous = this.repository.receipt(space.id, text(owner, 200), command.id, request);
      return previous ? { tree: this.tree(command.projectId), operation: previous } : null;
    });
    if (replay) return replay;
    const seed = await source.prepare();
    if (seed.images.length) throw new DocumentError("invalidImage");
    await authorize?.();
    return this.repository.transaction(() => {
      return this.createDocument(owner, { ...fields, body: seed.body }, identity, minimum);
    });
  }
  private createDocument(owner: string, value: unknown, source?: string, minimum?: number): DocumentTreeMutation {
    const command = navigationInput(value, ["parentId", "title", "locale", "body"]),
      input = command.input;
    if (minimum !== undefined) {
      const current = this.tree(command.projectId).version;
      if (current < minimum) throw new DocumentError("navigationConflict", 409);
      command.version = current;
    }
    const title = text(input.title, 200),
      locale = localeText(input.locale),
      parentId = input.parentId === undefined || input.parentId === null ? null : text(input.parentId, 128);
    const body = richDocumentInput(input.body === undefined ? emptyRichBody() : input.body);
    // A new document cannot already own an attachment. Asset ingestion is a separate authorized operation.
    if (body.images.length) throw new DocumentError("invalidImage");
    const actor = text(owner, 200),
      request = navigationRequest({
        kind: "create",
        id: command.id,
        projectId: command.projectId,
        version: minimum ?? command.version,
        parentId,
        title,
        locale,
        ...(source ? { source, ...(minimum === undefined ? {} : { append: true }) } : { body: body.body }),
      });
    if (!this.library.get(command.projectId)) {
      if (command.version !== 0) throw new DocumentError("navigationConflict", 409);
      if (parentId !== null) throw new DocumentError("notFound", 404);
      this.library.ensure(command.projectId, locale);
    }
    return this.apply(actor, command, request, (space, tree) => {
      if (tree.nodes.length >= DOCUMENT_TREE_LIMITS.documents) throw new DocumentError("tooManyDocuments", 409);
      if (parentId !== null && !tree.nodes.some((node) => node.documentId === parentId))
        throw new DocumentError("notFound", 404);
      const document = this.documents.createDocument({
        spaceId: space.id,
        path: randomUUID() + ".md",
        title,
        locale,
        body: body.body,
      }).document;
      const placement = {
        documentId: document.id,
        parentId,
        position: tree.nodes.filter((node) => node.parentId === parentId).length,
      };
      const next = insertTreeNodes(tree.nodes, [placement]);
      this.repository.insert(space.id, placement);
      this.repository.replace(space.id, next);
      return { documentId: document.id, affectedDocumentIds: [document.id], restoredToRoot: false };
    });
  }
  move(owner: string, value: unknown): DocumentTreeMutation {
    const command = navigationInput(value, ["documentId", "target"]),
      documentId = text(command.input.documentId, 128),
      target = navigationTarget(command.input.target);
    return this.apply(
      owner,
      command,
      navigationRequest({ kind: "move", ...commandIdentity(command), documentId, target }),
      (space, tree) => {
        this.repository.replace(space.id, moveDocumentTree(tree.nodes, documentId, target));
        return { documentId, affectedDocumentIds: documentSubtree(tree.nodes, documentId), restoredToRoot: false };
      },
    );
  }
  rename(owner: string, value: unknown): DocumentTreeMutation {
    const command = navigationInput(value, ["documentId", "title", "revision"]),
      input = command.input;
    const documentId = text(input.documentId, 128),
      title = text(input.title, 200),
      revision = expectedVersion(input.revision);
    return this.apply(
      owner,
      command,
      navigationRequest({ kind: "rename", ...commandIdentity(command), documentId, title, revision }),
      (_space, tree) => {
        this.active(tree, documentId);
        this.documents.renameDocument(documentId, title, revision);
        return { documentId, affectedDocumentIds: [documentId], restoredToRoot: false };
      },
    );
  }
  trash(owner: string, value: unknown): DocumentTreeMutation {
    const command = navigationInput(value, ["documentId", "revision"]),
      documentId = text(command.input.documentId, 128),
      revision = expectedVersion(command.input.revision);
    return this.apply(
      owner,
      command,
      navigationRequest({ kind: "trash", ...commandIdentity(command), documentId, revision }),
      (space, tree) => {
        const document = this.active(tree, documentId).document;
        if (document.revision !== revision) throw new DocumentError("conflict", 409);
        const affectedDocumentIds = documentSubtree(tree.nodes, documentId);
        this.repository.retire(space.id, affectedDocumentIds, command.id);
        this.repository.replace(space.id, liftRemovedNodes(tree.nodes, new Set(affectedDocumentIds)));
        return { documentId, affectedDocumentIds, restoredToRoot: false };
      },
    );
  }
  restore(owner: string, value: unknown): DocumentTreeMutation {
    const command = navigationInput(value, ["documentId", "toRoot"]),
      documentId = text(command.input.documentId, 128);
    if (command.input.toRoot !== undefined && typeof command.input.toRoot !== "boolean")
      throw new DocumentError("invalidInput");
    const toRoot = command.input.toRoot === true;
    return this.apply(
      owner,
      command,
      navigationRequest({ kind: "restore", ...commandIdentity(command), documentId, toRoot }),
      (space, tree) => {
        const document = this.documents.documents.record(documentId);
        if (document.spaceId !== space.id || !this.documents.documents.isTrashed(documentId))
          throw new DocumentError("notFound", 404);
        const tombstone = this.repository.tombstone(space.id, documentId);
        const restore = planTreeRestore(
          tree.nodes,
          tombstone ? this.repository.tombstones(space.id, tombstone.operationId) : [],
          documentId,
          toRoot,
        );
        this.repository.revive(restore.selected);
        for (const node of restore.additions) this.repository.insert(space.id, node);
        this.repository.replace(space.id, restore.next);
        return { documentId, affectedDocumentIds: restore.selected, restoredToRoot: restore.restoredToRoot };
      },
    );
  }
  private active(tree: ProjectDocumentTree, documentId: string) {
    const node = tree.nodes.find((candidate) => candidate.documentId === documentId);
    if (!node) throw new DocumentError("notFound", 404);
    return node;
  }
  private snapshot(projectId: string, spaceId: string): ProjectDocumentTree {
    const nodes = this.repository
      .rows(spaceId)
      .filter((node) => !node.trashed)
      .map(({ trashed: _trashed, ...node }) => node);
    validateDocumentTree(nodes);
    return { projectId, version: this.repository.version(spaceId)!, nodes };
  }
  private apply(
    owner: string,
    command: Command,
    request: string,
    mutate: (space: DocumentSpace, tree: ProjectDocumentTree) => Outcome,
  ): DocumentTreeMutation {
    owner = text(owner, 200);
    return navigationGuard(() =>
      this.repository.transaction(() => {
        const space = this.bootstrap.ensure(command.projectId);
        if (!space) throw new DocumentError("notFound", 404);
        const previous = this.repository.receipt(space.id, owner, command.id, request);
        if (previous) return { tree: this.snapshot(command.projectId, space.id), operation: previous };
        const tree = this.snapshot(command.projectId, space.id);
        if (tree.version !== command.version) throw new DocumentError("navigationConflict", 409);
        const outcome = mutate(space, tree);
        this.repository.bump(space.id, tree.version);
        const operation = { id: command.id, ...outcome, treeVersion: tree.version + 1 };
        this.repository.recordOperation(space.id, owner, command.id, request, outcome.documentId, operation);
        return { tree: this.snapshot(command.projectId, space.id), operation };
      }),
    );
  }
}
const commandIdentity = ({ id, projectId, version }: Command) => ({ id, projectId, version });
