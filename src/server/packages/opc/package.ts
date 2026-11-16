import { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import { opcAssert, OpcError } from "./errors.js";
import { XmlBudget, xmlChildren, type XmlLimits, type XmlDocument } from "./xml.js";
import { physicalPartName, opcPartKey, resolveOpcTarget, relationshipPartName } from "./uris.js";
import { OpcContentTypes } from "./content-types.js";

export const RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
export type OpcRelationship =
  | { readonly id: string; readonly type: string; readonly external: true; readonly target: string }
  | {
      readonly id: string;
      readonly type: string;
      readonly external: false;
      readonly target: string;
      readonly part: string;
      readonly fragment: string | null;
    };

/** A validated source tree owns bytes; OPC adds only names, content types and bounded XML relations. */
export class OpcPackage {
  private names = new Map<string, string>();
  private logical = new Map<string, string>();
  private budget: XmlBudget;
  readonly contentTypes: OpcContentTypes;
  constructor(
    readonly tree: ImmutableSourceTree,
    limits?: XmlLimits,
  ) {
    opcAssert(tree instanceof ImmutableSourceTree, "missingPart");
    this.budget = new XmlBudget(limits);
    for (const file of tree.files) {
      const name = physicalPartName(file.path),
        key = opcPartKey(name);
      opcAssert(!this.names.has(key), "duplicatePart");
      this.names.set(key, file.path);
      this.logical.set(file.path, name);
    }
    this.contentTypes = new OpcContentTypes(this.xml("[Content_Types].xml"), (name) => this.locate(name));
    for (const file of tree.files)
      if (opcPartKey(file.path) !== "[content_types].xml") this.contentTypes.forPart(file.path);
  }
  locate(logicalName: string): string {
    const name = this.names.get(opcPartKey(logicalName));
    opcAssert(name, "missingPart");
    return name;
  }
  xml(part: string): XmlDocument {
    const actual = this.tree.has(part) ? part : this.locate(physicalPartName(part));
    try {
      return this.budget.read(actual, this.tree.read(actual));
    } catch (error) {
      if (error instanceof OpcError) throw new OpcError(error.code, actual);
      throw error;
    }
  }
  relationships(part: string | null): readonly OpcRelationship[] {
    const actual = part === null ? null : this.locate(physicalPartName(part)),
      relationshipPath = relationshipPartName(actual),
      path = this.names.get(opcPartKey(physicalPartName(relationshipPath)));
    if (!path) return [];
    opcAssert(
      this.contentTypes.matches(path, "application/vnd.openxmlformats-package.relationships+xml"),
      "invalidRelationships",
    );
    const root = this.xml(path).documentElement!;
    opcAssert(
      root.namespaceURI === RELATIONSHIP_NAMESPACE && root.localName === "Relationships",
      "invalidRelationships",
    );
    const ids = new Set<string>();
    return Object.freeze(
      xmlChildren(root, RELATIONSHIP_NAMESPACE, "Relationship").map((item): OpcRelationship => {
        const id = item.getAttribute("Id") ?? "",
          type = item.getAttribute("Type") ?? "",
          target = item.getAttribute("Target") ?? "",
          mode = item.getAttribute("TargetMode");
        opcAssert(
          id.length > 0 && id.length <= 1024 && !/[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(id) && !ids.has(id),
          "invalidRelationships",
        );
        opcAssert(
          type.length > 0 &&
            type.length <= 2048 &&
            !/[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(type) &&
            target.length > 0 &&
            target.length <= 8192,
          "invalidRelationships",
        );
        opcAssert(mode === null || mode === "Internal" || mode === "External", "invalidRelationships");
        ids.add(id);
        if (mode === "External") return Object.freeze({ id, type, target, external: true });
        try {
          const resolved = resolveOpcTarget(actual === null ? null : this.logical.get(actual)!, target);
          return Object.freeze({
            id,
            type,
            target,
            external: false,
            part: this.locate(resolved.name),
            fragment: resolved.fragment,
          });
        } catch (error) {
          if (error instanceof OpcError) throw new OpcError("invalidRelationships");
          throw error;
        }
      }),
    );
  }
}
