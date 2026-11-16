import type { EditorialReceipt, EditorialSourceRef } from "../editorial/contracts.js";

/** Editor actions either propose a Markdown draft or report a reviewed source commit; neither erases rich data. */
export type DocumentSourceActionResult =
  | { kind: "markdown-draft"; base: EditorialSourceRef; content: string }
  | { kind: "source-applied"; receipt: EditorialReceipt };
