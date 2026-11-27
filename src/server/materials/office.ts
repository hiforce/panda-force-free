import { capturePackageSource } from "../../shared/packages/sources/reader.js";
import { openZipSource } from "../packages/zip/source.js";
import { OpcPackage, type OpcRelationship } from "../packages/opc/package.js";
import { xmlChildren, xmlDescendants, type XmlElement } from "../packages/opc/xml.js";
import { NativePresentation } from "../slides/office/package.js";
import { PRESENTATION_NAMESPACES } from "../slides/office/namespaces.js";
import { MaterialTextBuilder } from "./builder.js";
import { MATERIAL_TEXT_LIMITS as limits, MaterialTextError, type DetailedMaterialText } from "./contracts.js";

const relationships = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
];
const wordNamespaces = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];
const sheetNamespaces = [
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
];
const sourceLimits = {
  archiveBytes: limits.inputBytes,
  fileBytes: limits.inputBytes,
  totalBytes: 64 * 1024 * 1024,
  files: limits.parts,
  entries: limits.parts * 2,
};
const fail = (): never => {
  throw new MaterialTextError("unreadable");
};
const children = (node: XmlElement) =>
  Array.from(node.childNodes).filter((item): item is XmlElement => item.nodeType === 1);
function related(
  parts: OpcPackage,
  from: string | null,
  kind: string,
): Extract<OpcRelationship, { external: false }>[] {
  return parts
    .relationships(from)
    .filter((item) => relationships.some((ns) => item.type === ns + "/" + kind))
    .map((item) => (item.external || item.fragment !== null ? fail() : item));
}
async function packageSource(bytes: Uint8Array, kind: string) {
  const reader = await openZipSource(bytes, "material." + kind, sourceLimits),
    tree = await capturePackageSource(reader, undefined, sourceLimits),
    parts = new OpcPackage(tree),
    main = related(parts, null, "officeDocument");
  if (main.length !== 1) fail();
  return { parts, main: main[0]!.part };
}
function wordInline(node: XmlElement, ns: string): string {
  if (node.namespaceURI === ns) {
    if (node.localName === "t") return node.textContent ?? "";
    if (node.localName === "tab") return "\t";
    if (["br", "cr", "lastRenderedPageBreak"].includes(node.localName || "")) return "\n";
    if (["del", "delText", "instrText"].includes(node.localName || "")) return "";
  }
  if (
    node.namespaceURI === "http://schemas.openxmlformats.org/markup-compatibility/2006" &&
    node.localName === "AlternateContent"
  ) {
    const selected =
      children(node).find((item) => item.localName === "Choice") ||
      children(node).find((item) => item.localName === "Fallback");
    return selected ? wordInline(selected, ns) : "";
  }
  return children(node)
    .map((child) => wordInline(child, ns))
    .join("");
}
function wordBlocks(node: XmlElement, ns: string): string {
  if (node.namespaceURI === ns) {
    if (node.localName === "p") return wordInline(node, ns);
    if (node.localName === "tr")
      return xmlChildren(node, ns, "tc")
        .map((cell) => wordBlocks(cell, ns))
        .join("\t");
    if (node.localName === "del") return "";
  }
  return children(node)
    .map((child) => wordBlocks(child, ns))
    .filter(Boolean)
    .join("\n");
}
export async function wordMaterialText(bytes: Uint8Array): Promise<DetailedMaterialText> {
  const { parts, main } = await packageSource(bytes, "docx"),
    root = parts.xml(main).documentElement!,
    ns = root.namespaceURI;
  if (root.localName !== "document" || !wordNamespaces.includes(ns || "")) fail();
  const builder = new MaterialTextBuilder(),
    bodies = xmlChildren(root, ns!, "body");
  if (bodies.length !== 1) fail();
  builder.add(wordBlocks(bodies[0]!, ns!));
  for (const kind of ["header", "footer", "footnotes", "endnotes"]) {
    for (const part of related(parts, main, kind)) {
      const content = parts.xml(part.part).documentElement!;
      if (content.namespaceURI !== ns) fail();
      builder.add(wordBlocks(content, ns!));
    }
  }
  return builder.result();
}
function cellReference(value: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!match) fail();
  let column = 0;
  for (const char of match![1]!) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match![2]);
  if (column > 16384 || row > 1048576) fail();
  return row;
}
export async function workbookMaterialText(bytes: Uint8Array): Promise<DetailedMaterialText> {
  const { parts, main } = await packageSource(bytes, "xlsx"),
    root = parts.xml(main).documentElement!,
    ns = root.namespaceURI;
  if (root.localName !== "workbook" || !sheetNamespaces.includes(ns || "")) fail();
  const strings = related(parts, main, "sharedStrings");
  if (strings.length > 1) fail();
  const shared = strings.length
    ? xmlChildren(parts.xml(strings[0]!.part).documentElement!, ns!, "si").map((item) =>
        xmlDescendants(item, ns!, "t")
          .map((t) => t.textContent ?? "")
          .join(""),
      )
    : [];
  const parent = xmlChildren(root, ns!, "sheets");
  if (parent.length !== 1) fail();
  const sheets = xmlChildren(parent[0]!, ns!, "sheet");
  if (sheets.length > limits.sheets) throw new MaterialTextError("tooLarge");
  const references = related(parts, main, "worksheet"),
    builder = new MaterialTextBuilder();
  let cells = 0,
    expandedBytes = 0,
    hasContent = false;
  for (const sheet of sheets) {
    const id = relationships.map((r) => sheet.getAttributeNS(r, "id")).find(Boolean),
      part = references.find((item) => item.id === id);
    if (!part) fail();
    const content = parts.xml(part!.part).documentElement!;
    if (content.namespaceURI !== ns || content.localName !== "worksheet") fail();
    const rows: string[] = [];
    const merged = xmlDescendants(content, ns!, "mergeCell").map((item) => item.getAttribute("ref") || "");
    if (merged.length > 10000) throw new MaterialTextError("tooLarge");
    for (const range of merged) {
      const pair = range.split(":");
      if (pair.length !== 2) fail();
      for (const ref of pair) cellReference(ref);
    }
    for (const row of xmlDescendants(content, ns!, "row")) {
      const entries: { ref: string; value: string; formula?: string }[] = [];
      for (const cell of xmlChildren(row, ns!, "c")) {
        if (++cells > limits.cells) throw new MaterialTextError("tooLarge");
        const ref = cell.getAttribute("r") || "";
        cellReference(ref);
        const type = cell.getAttribute("t"),
          value = xmlChildren(cell, ns!, "v")[0]?.textContent || "",
          formula = xmlChildren(cell, ns!, "f")[0]?.textContent;
        let text = value;
        if (type === "s") {
          const index = Number(value);
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index >= shared.length) fail();
          text = shared[index]!;
        } else if (type === "inlineStr")
          text = xmlDescendants(cell, ns!, "t")
            .map((t) => t.textContent ?? "")
            .join("");
        else if (type === "b") {
          if (!["0", "1"].includes(value)) fail();
          text = value === "1" ? "true" : "false";
        }
        const entry = { ref, value: text, ...(formula ? { formula } : {}) };
        expandedBytes += Buffer.byteLength(JSON.stringify(entry)) + 64;
        if (expandedBytes > limits.textBytes) throw new MaterialTextError("tooLarge");
        if (text.trim() || formula?.trim()) hasContent = true;
        entries.push(entry);
      }
      if (entries.length) rows.push(JSON.stringify({ row: row.getAttribute("r"), cells: entries }));
    }
    builder.add(
      JSON.stringify({ sheet: sheet.getAttribute("name"), state: sheet.getAttribute("state") || "visible", merged }) +
        "\n" +
        rows.join("\n"),
    );
  }
  if (!hasContent) throw new MaterialTextError("empty");
  return builder.result();
}
export async function presentationMaterialText(bytes: Uint8Array): Promise<DetailedMaterialText> {
  const presentation = await NativePresentation.open(bytes, "material.pptx", { sourceLimits }),
    ns = PRESENTATION_NAMESPACES.find((item) => item.dialect === presentation.index.dialect)!;
  if (presentation.index.kind !== "pptx") fail();
  if (presentation.index.slides.length > limits.pages) throw new MaterialTextError("tooLarge");
  const builder = new MaterialTextBuilder(),
    text = (root: XmlElement) =>
      xmlDescendants(root, ns.a, "p")
        .map((p) =>
          children(p)
            .map((child) => {
              if (child.namespaceURI !== ns.a) return "";
              if (child.localName === "br") return "\n";
              if (child.localName !== "r" && child.localName !== "fld") return "";
              return xmlDescendants(child, ns.a, "t")
                .map((t) => t.textContent ?? "")
                .join("");
            })
            .join(""),
        )
        .join("\n");
  for (const slide of presentation.index.slides) {
    let content = text(presentation.parts.xml(slide.path).documentElement!);
    for (const notes of related(presentation.parts, slide.path, "notesSlide"))
      content += "\n\n" + text(presentation.parts.xml(notes.part).documentElement!);
    builder.add(content);
  }
  return builder.result();
}
