import type { ContentBlock } from "../../../shared/publishing/content.js";
import { plainBlock } from "./render.js";

/** A bounded text projection, without expanding spans into a potentially enormous matrix. */
export function gridMarkdown(block: Extract<ContentBlock, { kind: "grid" }>): string {
  const escape = (text: string) =>
      text
        .replaceAll("\\", "\\\\")
        .replaceAll("|", "\\|")
        .replace(/[<>`*_[\]{}#!]/g, "\\$&")
        .replaceAll("\n", " "),
    row = (cells: string[]) => "| " + cells.map(escape).join(" | ") + " |",
    content = block.rows.map((cells) => cells.map((cell) => cell.children.map(plainBlock).join("\n"))),
    columns = content[0]?.length || 0,
    rectangular =
      columns > 0 &&
      block.rows.every(
        (cells) => cells.length === columns && cells.every((cell) => cell.colspan === 1 && cell.rowspan === 1),
      );
  if (rectangular) {
    const header = block.rows[0]!.every((cell) => cell.header)
      ? content.shift()!
      : Array.from({ length: columns }, () => "");
    return [row(header), row(header.map(() => "---")), ...content.map(row)].join("\n");
  }
  return content.map((cells) => cells.map(escape).join(" | ")).join("\n\n");
}
