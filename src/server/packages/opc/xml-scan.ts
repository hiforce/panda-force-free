import { opcAssert } from "./errors.js";

/** Bound allocation before DOM construction; the XML parser remains the syntax authority. */
export function scanXmlBudget(text: string, limits: { nodes: number; depth: number; attributes: number }) {
  let cursor = 0,
    nodes = 1,
    depth = 0;
  const count = () => opcAssert(++nodes <= limits.nodes, "xmlLimitExceeded");
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start !== cursor) count();
    if (start < 0) break;
    if (text.startsWith("<!--", start) || text.startsWith("<![CDATA[", start) || text.startsWith("<?", start)) {
      const comment = text.startsWith("<!--", start),
        cdata = text.startsWith("<![CDATA[", start),
        end = comment ? "-->" : cdata ? "]]>" : "?>",
        offset = comment ? 4 : cdata ? 9 : 2,
        stop = text.indexOf(end, start + offset);
      opcAssert(stop >= 0, "invalidXml");
      count();
      cursor = stop + end.length;
      continue;
    }
    opcAssert(!text.startsWith("<!", start), "invalidXml");
    if (text.startsWith("</", start)) {
      const stop = text.indexOf(">", start + 2);
      opcAssert(stop >= 0 && depth > 0, "invalidXml");
      depth--;
      cursor = stop + 1;
      continue;
    }
    count();
    let index = start + 1,
      attributes = 0;
    while (index < text.length && !/[\s/>]/.test(text[index]!)) index++;
    opcAssert(index > start + 1, "invalidXml");
    while (index < text.length) {
      while (/\s/.test(text[index] ?? "")) index++;
      if (text[index] === ">" || (text[index] === "/" && text[index + 1] === ">")) break;
      opcAssert(++attributes <= limits.attributes, "xmlLimitExceeded");
      const name = index;
      while (index < text.length && !/[\s=/>]/.test(text[index]!)) index++;
      opcAssert(index > name, "invalidXml");
      while (/\s/.test(text[index] ?? "")) index++;
      opcAssert(text[index++] === "=", "invalidXml");
      while (/\s/.test(text[index] ?? "")) index++;
      const quote = text[index++];
      opcAssert(quote === "'" || quote === '"', "invalidXml");
      const stop = text.indexOf(quote, index);
      opcAssert(stop >= index && !text.slice(index, stop).includes("<"), "invalidXml");
      index = stop + 1;
    }
    opcAssert(index < text.length, "invalidXml");
    if (text[index] === "/") cursor = index + 2;
    else {
      opcAssert(++depth <= limits.depth, "xmlLimitExceeded");
      cursor = index + 1;
    }
  }
  opcAssert(depth === 0, "invalidXml");
  return nodes;
}
