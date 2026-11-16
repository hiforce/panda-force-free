import type { RichDocumentBody } from "./rich-body.js";
import { stableJson } from "../stable-json.js";

/** Hash this canonical input, never a rich document's lossy Markdown exchange projection. */
export const documentContentIdentity = (content: string, body?: RichDocumentBody): string =>
  body ? "richtext-v1\0" + stableJson(body) : content;
