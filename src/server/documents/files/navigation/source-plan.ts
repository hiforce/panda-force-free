import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DocumentDetail } from "../../../../shared/documents/contracts.js";
import { documentContentIdentity } from "../../../../shared/documents/content-identity.js";
import { readSavedDocument } from "../../../project-content/drafts/current.js";
import { revisionCommitMessage } from "../../../project-content/document-history.js";
import type { ProjectContentPlan } from "../../../project-content/plan-view.js";
import type { ProjectContentProject } from "../../../project-content/project.js";
import type { FileTreeCommand } from "./commands.js";
import type { FileTreeSnapshot } from "./read.js";
import { DocumentError } from "../../errors.js";
import type { FileDocumentCreationContent } from "../creation-content.js";
import { assertCheckpointContent } from "../../../project-content/drafts/checkpoint-policy.js";

export type PrepareDocumentSource = (documentId: string) => ReturnType<FileDocumentCreationContent["prepare"]>;

export async function prepareTreeLibrary(
  project: ProjectContentProject,
  plan: ProjectContentPlan,
  command: Extract<FileTreeCommand, { kind: "create" }>,
) {
  const id = randomUUID(),
    now = Date.now();
  plan.apply(
    await project.spaces.prepare(
      plan,
      {
        schema: 1,
        sourceProfile: null,
        space: {
          id,
          projectId: command.projectId,
          code: "__documents__",
          name: "Project documents",
          engine: "markdown",
          theme: "default",
          sourceMode: "managed",
          sourceRoot: join(project.owned.directory, "documents"),
          locale: command.locale,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      },
      null,
      "library",
    ),
  );
}
export async function prepareCreatedSource(
  project: ProjectContentProject,
  plan: ProjectContentPlan,
  command: Extract<FileTreeCommand, { kind: "create" }>,
  spaceId: string,
  prepare?: PrepareDocumentSource,
) {
  const id = randomUUID(),
    revisionId = randomUUID(),
    now = Date.now(),
    prepared = await prepare?.(id),
    source = prepared?.source ?? command.source,
    contentHash = createHash("sha256").update(documentContentIdentity(source.content, source.body)).digest("hex"),
    detail: DocumentDetail = {
      document: {
        id,
        spaceId,
        path: id + ".md",
        title: command.title,
        locale: command.locale,
        revision: 1,
        revisionId,
        contentHash,
        importedHash: null,
        importedRevision: null,
        updatedAt: now,
      },
      revision: {
        id: revisionId,
        documentId: id,
        number: 1,
        title: command.title,
        locale: command.locale,
        content: source.content,
        body: source.body,
        resources: [],
        contentHash,
        createdAt: now,
      },
    };
  plan.apply(await project.documents.prepare(plan, detail, null));
  if (prepared?.assets.length) plan.apply(await project.assets.prepareMany(plan, prepared.assets));
  await assertCheckpointContent(plan, command.projectId, id, spaceId, {
    title: command.title,
    locale: command.locale,
    content: source.content,
    body: source.body,
    resources: [],
  });
  const sourceReference = prepared?.copiedFrom;
  const provenance = sourceReference
    ? "\nPanda-Copied-From: personal/" +
      sourceReference.documentId +
      "\nPanda-Copied-Revision: " +
      sourceReference.revisionId
    : "";
  return { documentId: id, message: revisionCommitMessage(detail.revision) + provenance };
}
export async function prepareRenamedSource(
  project: ProjectContentProject,
  plan: ProjectContentPlan,
  command: Extract<FileTreeCommand, { kind: "rename" }>,
  snapshot: FileTreeSnapshot,
) {
  const active = snapshot.tree.nodes.find((node) => node.documentId === command.documentId);
  if (!active) throw new DocumentError("notFound", 404);
  if (active.document.revision !== command.revision) throw new DocumentError("conflict", 409);
  if (active.document.title === command.title) return undefined;
  const current = await readSavedDocument(plan, command.projectId, command.documentId),
    id = randomUUID(),
    number = command.revision + 1,
    now = Math.max(Date.now(), current.document.updatedAt),
    detail: DocumentDetail = {
      document: { ...current.document, title: command.title, revision: number, revisionId: id, updatedAt: now },
      revision: { ...current.revision, id, number, title: command.title, createdAt: now },
    };
  plan.apply(await project.documents.prepare(plan, detail, command.revision));
  return revisionCommitMessage(detail.revision);
}
