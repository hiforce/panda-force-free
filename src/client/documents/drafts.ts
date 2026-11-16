import { storage, STORAGE_KEYS } from "../storage.js";
import type { DocumentDetail } from "../../shared/documents/contracts.js";
import { normalizeRichBody, type RichDocumentBody } from "../../shared/documents/rich-body.js";
import { stableJson } from "../../shared/stable-json.js";

export interface DocumentDraft {
  revision: number;
  title: string;
  locale: string;
  content: string;
  body?: RichDocumentBody;
  updatedAt: number;
}
const maxBytes = 2 * 1024 * 1024;
/** Identity- and tab-scoped recovery storage; server revisions remain the source of truth. */
export class DocumentDrafts {
  private memory = new Map<string, DocumentDraft>();
  constructor(private identity: string) {}
  read(id: string): DocumentDraft | null {
    if (this.memory.has(id)) return this.memory.get(id)!;
    if (!this.identity) return null;
    const candidate: unknown = storage.getSessionJson(STORAGE_KEYS.documentDraftFor(this.identity, id), null);
    if (!candidate || typeof candidate !== "object") return null;
    const draft = candidate as Partial<DocumentDraft>;
    if (
      typeof draft.title !== "string" ||
      typeof draft.locale !== "string" ||
      typeof draft.content !== "string" ||
      typeof draft.revision !== "number" ||
      typeof draft.updatedAt !== "number" ||
      Date.now() - draft.updatedAt > 30 * 86400_000 ||
      draft.content.length > maxBytes
    )
      return null;
    try {
      if (draft.body) draft.body = normalizeRichBody(draft.body);
    } catch {
      return null;
    }
    return draft as DocumentDraft;
  }
  write(id: string, draft: DocumentDraft) {
    this.memory.set(id, draft);
    if (this.identity && new TextEncoder().encode(JSON.stringify(draft)).length <= maxBytes * 2 + 8192)
      storage.setSessionJson(STORAGE_KEYS.documentDraftFor(this.identity, id), draft);
  }
  clear(id: string) {
    this.memory.delete(id);
    if (this.identity) storage.removeSession(STORAGE_KEYS.documentDraftFor(this.identity, id));
  }
}
export function revisionDraft(detail: DocumentDetail): DocumentDraft {
  return {
    revision: detail.document.revision,
    title: detail.revision.title,
    locale: detail.revision.locale,
    content: detail.revision.content,
    ...(detail.revision.body ? { body: detail.revision.body } : {}),
    updatedAt: Date.now(),
  };
}
export function isDraftChanged(draft: DocumentDraft, detail: DocumentDetail) {
  return (
    draft.title !== detail.revision.title ||
    draft.locale !== detail.revision.locale ||
    draft.content !== detail.revision.content ||
    stableJson(draft.body) !== stableJson(detail.revision.body)
  );
}

/** Adopt server normalization only for fields unchanged since dispatch; newer typing keeps the new revision base. */
export function acknowledgeDocumentSave(
  current: DocumentDraft,
  submitted: DocumentDraft,
  saved: DocumentDetail,
): DocumentDraft {
  const contentUnchanged =
    current.content === submitted.content && stableJson(current.body) === stableJson(submitted.body);
  const acknowledged = {
    ...current,
    revision: saved.document.revision,
    title: current.title === submitted.title ? saved.revision.title : current.title,
    locale: current.locale === submitted.locale ? saved.revision.locale : current.locale,
  };
  if (contentUnchanged) {
    acknowledged.content = saved.revision.content;
    if (saved.revision.body) acknowledged.body = saved.revision.body;
    else delete acknowledged.body;
  }
  return acknowledged;
}
