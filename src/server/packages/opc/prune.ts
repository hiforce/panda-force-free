import { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import { OpcPackage } from "./package.js";
import { CONTENT_TYPE_NAMESPACE } from "./content-types.js";
import { opcPartKey, physicalPartName, relationshipPartName, resolveOpcTarget } from "./uris.js";
import { serializeXml, xmlChildren } from "./xml.js";

/** Reachability starts at package relationships; opaque referenced parts remain intact and external links are never fetched. */
export async function reachableOpcParts(
  input: ReadonlyMap<string, Uint8Array>,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const tree = await ImmutableSourceTree.create([...input].map(([path, bytes]) => ({ path, bytes }))),
    opc = new OpcPackage(tree),
    names = new Map(tree.files.map((f) => [opcPartKey(physicalPartName(f.path)), f.path])),
    visited = new Set<string>(),
    keep = new Set<string>(),
    pending: (string | null)[] = [null];
  while (pending.length) {
    const part = pending.pop() as string | null;
    if (part !== null) {
      if (visited.has(part)) continue;
      visited.add(part);
      keep.add(part);
    }
    const relationships = names.get(opcPartKey(physicalPartName(relationshipPartName(part))));
    if (relationships) keep.add(relationships);
    for (const ref of opc.relationships(part)) if (!ref.external) pending.push(ref.part);
  }
  const contentTypes = opc.locate("[Content_Types].xml"),
    document = opc.xml(contentTypes),
    root = document.documentElement!;
  for (const override of xmlChildren(root, CONTENT_TYPE_NAMESPACE, "Override"))
    if (!keep.has(opc.locate(resolveOpcTarget(null, override.getAttribute("PartName")!).name)))
      root.removeChild(override);
  const output = new Map([...keep].map((path) => [path, tree.read(path)]));
  output.set(contentTypes, serializeXml(document));
  return output;
}
