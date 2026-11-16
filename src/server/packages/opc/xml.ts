import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";
import { OpcError, opcAssert } from "./errors.js";
import { scanXmlBudget } from "./xml-scan.js";

export type XmlDocument = Document;
export type XmlElement = Element;
export interface XmlLimits {
  partBytes: number;
  totalBytes: number;
  nodes: number;
  partNodes: number;
  depth: number;
  attributes: number;
}
export const DEFAULT_XML_LIMITS: Readonly<XmlLimits> = Object.freeze({
  partBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  nodes: 1_000_000,
  partNodes: 100_000,
  depth: 128,
  attributes: 128,
});

function decode(bytes: Uint8Array) {
  const utf16le = (bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 60 && bytes[1] === 0),
    utf16be = (bytes[0] === 254 && bytes[1] === 255) || (bytes[0] === 0 && bytes[1] === 60),
    encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new OpcError("invalidXml");
  }
  const declared = /^<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/i.exec(text)?.[1]?.toLowerCase();
  opcAssert(
    !declared || (encoding === "utf-8" ? declared === "utf-8" : declared === "utf-16" || declared === encoding),
    "unsupportedXmlEncoding",
  );
  return text;
}

/** One package owns the parsing budget; callers receive detached DOMs, never mutable cached authority. */
export class XmlBudget {
  private bytes = 0;
  private nodes = 0;
  private cache = new Map<string, Document>();
  readonly limits: Readonly<XmlLimits>;
  constructor(limits: XmlLimits = DEFAULT_XML_LIMITS) {
    opcAssert(
      Object.keys(limits).length === Object.keys(DEFAULT_XML_LIMITS).length &&
        Object.keys(DEFAULT_XML_LIMITS).every((key) => {
          const n = limits[key as keyof XmlLimits];
          return Number.isSafeInteger(n) && n > 0;
        }),
      "xmlLimitExceeded",
    );
    this.limits = Object.freeze({ ...limits });
  }
  read(key: string, bytes: Uint8Array): Document {
    const cached = this.cache.get(key);
    if (cached) return cached.cloneNode(true) as Document;
    opcAssert(
      bytes.length <= this.limits.partBytes && this.bytes + bytes.length <= this.limits.totalBytes,
      "xmlLimitExceeded",
    );
    this.bytes += bytes.length;
    const text = decode(bytes);
    scanXmlBudget(text, { ...this.limits, nodes: Math.min(this.limits.partNodes, this.limits.nodes - this.nodes) });
    let document: Document;
    try {
      document = new DOMParser({
        onError: () => {
          throw new OpcError("invalidXml");
        },
      }).parseFromString(text, "application/xml");
    } catch (error) {
      if (error instanceof OpcError) throw error;
      throw new OpcError("invalidXml");
    }
    opcAssert(document.documentElement && !document.doctype, "invalidXml");
    const pending: { node: Node; depth: number }[] = [{ node: document, depth: 0 }];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      opcAssert(++this.nodes <= this.limits.nodes && depth <= this.limits.depth, "xmlLimitExceeded");
      if (node.nodeType === 1)
        opcAssert((node as Element).attributes.length <= this.limits.attributes, "xmlLimitExceeded");
      for (let child = node.lastChild; child; child = child.previousSibling)
        pending.push({ node: child, depth: depth + 1 });
    }
    this.cache.set(key, document);
    return document.cloneNode(true) as Document;
  }
}

export function xmlChildren(parent: Node, namespace: string, localName: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 && (node as Element).namespaceURI === namespace && (node as Element).localName === localName,
  );
}
export const xmlDescendants = (parent: Document | Element, namespace: string, localName: string): Element[] =>
  Array.from(parent.getElementsByTagNameNS(namespace, localName));

/** Edited parts are UTF-8 regardless of the original part's UTF-8/UTF-16 declaration. */
export function serializeXml(document: Document): Uint8Array {
  const text = new XMLSerializer()
    .serializeToString(document)
    .replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*['"])[^'"]+(['"])/i, "$1UTF-8$2");
  return new TextEncoder().encode(text);
}
