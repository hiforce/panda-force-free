import type { XmlDocument } from "./xml.js";
import { xmlChildren } from "./xml.js";
import { opcAssert } from "./errors.js";
import { opcPartKey, resolveOpcTarget } from "./uris.js";

export const CONTENT_TYPE_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const mime = (value: string) => /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) && value.length <= 255;

export class OpcContentTypes {
  private defaults = new Map<string, string>();
  private overrides = new Map<string, string>();
  constructor(document: XmlDocument, locate: (logical: string) => string) {
    const root = document.documentElement!;
    opcAssert(root.namespaceURI === CONTENT_TYPE_NAMESPACE && root.localName === "Types", "invalidContentTypes");
    for (const item of xmlChildren(root, CONTENT_TYPE_NAMESPACE, "Default")) {
      const extension = item.getAttribute("Extension") ?? "",
        type = item.getAttribute("ContentType") ?? "",
        key = opcPartKey(extension);
      opcAssert(
        /^[A-Za-z0-9_-]{1,64}$/.test(extension) && mime(type) && !this.defaults.has(key),
        "invalidContentTypes",
      );
      this.defaults.set(key, type);
    }
    for (const item of xmlChildren(root, CONTENT_TYPE_NAMESPACE, "Override")) {
      const name = item.getAttribute("PartName") ?? "",
        type = item.getAttribute("ContentType") ?? "";
      opcAssert(name.startsWith("/") && mime(type), "invalidContentTypes");
      const target = resolveOpcTarget(null, name);
      opcAssert(target.fragment === null, "invalidContentTypes");
      const key = opcPartKey(locate(target.name));
      opcAssert(!this.overrides.has(key), "invalidContentTypes");
      this.overrides.set(key, type);
    }
  }
  forPart(physical: string): string {
    const extension = physical.split("/").at(-1)!.split(".").at(-1)!;
    const type = this.overrides.get(opcPartKey(physical)) ?? this.defaults.get(opcPartKey(extension));
    opcAssert(type, "invalidContentTypes");
    return type;
  }
  matches(physical: string, expected: string): boolean {
    return opcPartKey(this.forPart(physical)) === opcPartKey(expected);
  }
}
