import { zip, type Zippable } from "fflate";
import { DEFAULT_SOURCE_LIMITS } from "../../../shared/packages/sources/contracts.js";
import { CONTENT_TYPE_NAMESPACE } from "./content-types.js";
import { OpcPackage } from "./package.js";
import { opcAssert } from "./errors.js";
import { physicalPartName, opcPartKey, resolveOpcTarget } from "./uris.js";
import { XmlBudget, xmlChildren, serializeXml, type XmlDocument } from "./xml.js";
import { reachableOpcParts } from "./prune.js";

/** A private overlay changes selected parts while the original package continues to own its exact bytes. */
export class OpcEdit {
  private changes = new Map<string, Uint8Array>();
  private names: Map<string, string>;
  constructor(readonly source: OpcPackage) {
    this.names = new Map(source.tree.files.map((file) => [opcPartKey(physicalPartName(file.path)), file.path]));
  }
  locate(path: string): string {
    const name = this.names.get(opcPartKey(physicalPartName(path)));
    opcAssert(name, "missingPart");
    return name;
  }
  read(path: string): Uint8Array {
    const changed = this.changes.get(path);
    return changed ? new Uint8Array(changed) : this.source.tree.read(path);
  }
  xml(path: string): XmlDocument {
    return this.changes.has(path) ? new XmlBudget().read(path, this.read(path)) : this.source.xml(path);
  }
  replace(path: string, bytes: Uint8Array): void {
    opcAssert(this.source.tree.has(path) || this.changes.has(path), "missingPart");
    opcAssert(bytes.length <= DEFAULT_SOURCE_LIMITS.fileBytes, "xmlLimitExceeded");
    this.changes.set(path, new Uint8Array(bytes));
  }
  setXml(path: string, document: XmlDocument): void {
    this.replace(path, serializeXml(document));
  }
  available(path: string): boolean {
    return !this.names.has(opcPartKey(physicalPartName(path)));
  }
  add(path: string, bytes: Uint8Array, mediaType: string): void {
    opcAssert(this.available(path), "duplicatePart");
    opcAssert(bytes.length <= DEFAULT_SOURCE_LIMITS.fileBytes, "xmlLimitExceeded");
    this.names.set(opcPartKey(physicalPartName(path)), path);
    this.changes.set(path, new Uint8Array(bytes));
    this.setContentType(path, mediaType);
  }
  setContentType(path: string, mediaType: string): void {
    opcAssert(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType), "invalidContentTypes");
    const physical = this.source.locate("[Content_Types].xml"),
      document = this.xml(physical),
      root = document.documentElement!,
      logical = physicalPartName(path),
      old = xmlChildren(root, CONTENT_TYPE_NAMESPACE, "Override").find(
        (item) => opcPartKey(resolveOpcTarget(null, item.getAttribute("PartName") ?? "").name) === opcPartKey(logical),
      ),
      element = old ?? document.createElementNS(CONTENT_TYPE_NAMESPACE, "Override");
    if (!old) {
      element.setAttribute("PartName", "/" + logical.split("/").map(encodeURIComponent).join("/"));
      root.appendChild(element);
    }
    element.setAttribute("ContentType", mediaType);
    this.setXml(physical, document);
  }
  async archive(selection: { pruneUnreachable?: boolean } = {}): Promise<Uint8Array> {
    const files = new Map(this.source.tree.files.map((file) => [file.path, this.source.tree.read(file.path)]));
    for (const [path, bytes] of this.changes) files.set(path, new Uint8Array(bytes));
    opcAssert(
      files.size <= DEFAULT_SOURCE_LIMITS.files &&
        [...files.values()].reduce((n, bytes) => n + bytes.length, 0) <= DEFAULT_SOURCE_LIMITS.totalBytes,
      "xmlLimitExceeded",
    );
    const selected = selection.pruneUnreachable ? await reachableOpcParts(files) : files;
    const entries: Zippable = Object.create(null),
      options = { level: 0 as const, mtime: new Date("2000-01-01T00:00:00Z"), attrs: (0o100644 << 16) >>> 0, os: 3 };
    for (const path of [...selected.keys()].sort()) entries[path] = [selected.get(path)!, options];
    const bytes = await new Promise<Uint8Array>((resolve, reject) =>
      zip(entries, { level: 0 }, (error, value) => (error ? reject(error) : resolve(value))),
    );
    opcAssert(bytes.length <= DEFAULT_SOURCE_LIMITS.archiveBytes, "xmlLimitExceeded");
    return bytes;
  }
}
