import { stableJson } from "../../../shared/stable-json.js";
import { normalizeRichBody } from "../../../shared/documents/rich-body.js";
import type { DocumentWorkingContent } from "../../../shared/documents/working-copy.js";
import { STORAGE_KEYS, documentRecoveryStorage } from "../../storage.js";
import type { FileEditorCommand } from "./api.js";

export interface FileEditorRecovery {
  baseRevisionId: string;
  version: number;
  working: DocumentWorkingContent;
  acknowledged: DocumentWorkingContent;
  pending: FileEditorCommand | null;
}
export interface FileRecoveryPort {
  read(): FileEditorRecovery | null;
  write(value: FileEditorRecovery | null): void;
}
/** Recovery is isolated by account, project and document; failed storage never permits an unrecorded mutation. */
export function fileRecovery(
  identity: string,
  project: string,
  document: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = documentRecoveryStorage,
): FileRecoveryPort {
  const key = STORAGE_KEYS.documentDraftFor(identity, "file:" + project + ":" + document);
  function content(value: unknown): value is DocumentWorkingContent {
    if (!value || typeof value !== "object") return false;
    const v = value as DocumentWorkingContent;
    if (
      typeof v.title !== "string" ||
      typeof v.locale !== "string" ||
      typeof v.content !== "string" ||
      !Array.isArray(v.resources)
    )
      return false;
    if (v.body) normalizeRichBody(v.body);
    return true;
  }
  return {
    read() {
      const bytes = storage.getItem(key);
      if (!bytes) return null;
      try {
        if (bytes.length > 8 * 1024 * 1024) throw Error("Oversized recovery");
        const v = JSON.parse(bytes);
        if (
          v.schema !== 1 ||
          !/^[a-f0-9-]{36}$/.test(v.baseRevisionId) ||
          !Number.isSafeInteger(v.version) ||
          v.version < 0 ||
          !content(v.working) ||
          !content(v.acknowledged) ||
          (v.pending &&
            (!["autosave", "discard", "save", "restore"].includes(v.pending.kind) ||
              !/^[a-f0-9-]{36}$/.test(v.pending.input?.operationId)))
        )
          throw Error("Invalid recovery");
        return v;
      } catch {
        throw Error("Document recovery is invalid; keep the browser data until it has been exported");
      }
    },
    write(value) {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, stableJson({ schema: 1, ...value }));
    },
  };
}
