import { DocumentOwnershipMove } from "./move.js";
import type { FileOwnershipSnapshot } from "./file-source.js";
/** Kept as the native adapter entry point; the transfer protocol also serves relational storage. */
export class FileDocumentOwnershipMove extends DocumentOwnershipMove<FileOwnershipSnapshot> {}
