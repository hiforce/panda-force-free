import type { RichDocumentBody } from "../../shared/documents/rich-body.js";
import type { RichTextEdit } from "../../shared/editorial/contracts.js";
import { applyRichTextEdits, EditorialPatchError } from "../../shared/editorial/rich-edits.js";
import { EditorialError } from "./errors.js";

export function editorialBody(body: RichDocumentBody, edits: RichTextEdit[]) {
  try {
    return applyRichTextEdits(body, edits);
  } catch (error) {
    if (error instanceof EditorialPatchError) throw new EditorialError("invalidPatch", 409);
    throw error;
  }
}
