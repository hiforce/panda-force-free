import { createHash } from "node:crypto";
import type { DocumentWorkingContent } from "../../../shared/documents/working-copy.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { draftContent } from "../../project-content/drafts/content.js";
import type { ProjectDraftCommand } from "../../project-content/drafts/store.js";
import type { ContentAuthor } from "../../project-content/git/process.js";
import { DocumentError } from "../errors.js";
import { contentText, localeText, text, documentInput as editorInput } from "../validation.js";
import { richDocumentInput } from "../rich-codec.js";
import { documentIdentity } from "./projects.js";

export { documentInput as editorInput } from "../validation.js";
export function documentOperationUuid(value: unknown): string {
  const id = text(value, 128).toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new DocumentError("invalidInput");
  return id;
}
function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new DocumentError("invalidInput");
  return Number(value);
}
export function draftCommand(actor: string, documentId: string, value: Record<string, unknown>): ProjectDraftCommand {
  return {
    actor: text(actor, 800),
    documentId: documentIdentity(documentId),
    expectedVersion: generation(value.version),
    baseRevisionId: documentIdentity(value.baseRevisionId),
    operationId: documentIdentity(value.operationId),
  };
}
export function documentAuthor(actor: string): ContentAuthor {
  return {
    name: "PandaForce operator",
    email: createHash("sha256").update(text(actor, 800)).digest("hex") + "@operators.pandaforce.local",
  };
}
export function checkpointCommand(actor: string, documentId: string, value: Record<string, unknown>) {
  return {
    documentId: documentIdentity(documentId),
    expectedRevisionId: documentIdentity(value.revisionId),
    expectedDraftVersion: generation(value.draftVersion),
    operationId: documentIdentity(value.operationId),
    author: documentAuthor(actor),
  };
}

/** Validate the request once before IO; the storage command receives a detached canonical source, never a live request object. */
export function workingContent(value: unknown): DocumentWorkingContent {
  const input = editorInput(value, ["title", "locale", "content", "body", "resources"]),
    source = input.body === undefined ? { content: contentText(input.content) } : richDocumentInput(input.body);
  try {
    return draftContent({
      title: text(input.title, 200),
      locale: localeText(input.locale),
      content: source.content,
      ...("body" in source ? { body: source.body } : {}),
      resources: input.resources === undefined ? [] : input.resources,
    });
  } catch (error) {
    if (error instanceof ProjectContentError) throw new DocumentError("invalidInput");
    throw error;
  }
}
