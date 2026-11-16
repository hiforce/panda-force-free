import { emptyRichBody } from "../../../../shared/documents/rich-body.js";
import { navigationInput, navigationRequest, navigationTarget } from "../../navigation/validation.js";
import { text, localeText, expectedVersion } from "../../validation.js";
import { richDocumentInput } from "../../rich-codec.js";
import { DocumentError } from "../../errors.js";
import { documentIdentity } from "../projects.js";

type Base = { id: string; projectId: string; version: number; owner: string; request: string };
export type FileTreeCommand = Base &
  (
    | {
        kind: "create";
        parentId: string | null;
        title: string;
        locale: string;
        source: ReturnType<typeof richDocumentInput>;
      }
    | { kind: "move"; documentId: string; target: ReturnType<typeof navigationTarget> }
    | { kind: "rename"; documentId: string; title: string; revision: number }
    | { kind: "trash"; documentId: string; revision: number }
    | { kind: "restore"; documentId: string; toRoot: boolean }
  );

/** Capture source and operation identity before asynchronous authorization or project IO. */
export function fileTreeCommand(kind: FileTreeCommand["kind"], actor: string, value: unknown): FileTreeCommand {
  const keys =
      kind === "create"
        ? ["parentId", "title", "locale", "body"]
        : kind === "move"
          ? ["documentId", "target"]
          : kind === "rename"
            ? ["documentId", "title", "revision"]
            : kind === "trash"
              ? ["documentId", "revision"]
              : ["documentId", "toRoot"],
    { input, id, projectId: project, version } = navigationInput(value, keys),
    projectId = documentIdentity(project),
    owner = text(actor, 200),
    identity = { id, projectId, version };
  if (kind === "create") {
    const title = text(input.title, 200),
      locale = localeText(input.locale),
      parentId = input.parentId === undefined || input.parentId === null ? null : documentIdentity(input.parentId),
      source = richDocumentInput(input.body === undefined ? emptyRichBody() : input.body);
    if (source.images.length) throw new DocumentError("invalidImage");
    return {
      kind,
      ...identity,
      owner,
      parentId,
      title,
      locale,
      source,
      request: navigationRequest({ kind, ...identity, parentId, title, locale, body: source.body }),
    };
  }
  const documentId = documentIdentity(input.documentId);
  if (kind === "move") {
    const target = navigationTarget(input.target);
    if (target.kind !== "root") documentIdentity(target.documentId);
    return {
      kind,
      ...identity,
      owner,
      documentId,
      target,
      request: navigationRequest({ kind, ...identity, documentId, target }),
    };
  }
  if (kind === "rename") {
    const title = text(input.title, 200),
      revision = expectedVersion(input.revision);
    return {
      kind,
      ...identity,
      owner,
      documentId,
      title,
      revision,
      request: navigationRequest({ kind, ...identity, documentId, title, revision }),
    };
  }
  if (kind === "trash") {
    const revision = expectedVersion(input.revision);
    return {
      kind,
      ...identity,
      owner,
      documentId,
      revision,
      request: navigationRequest({ kind, ...identity, documentId, revision }),
    };
  }
  if (input.toRoot !== undefined && typeof input.toRoot !== "boolean") throw new DocumentError("invalidInput");
  const toRoot = input.toRoot === true;
  return {
    kind,
    ...identity,
    owner,
    documentId,
    toRoot,
    request: navigationRequest({ kind, ...identity, documentId, toRoot }),
  };
}
