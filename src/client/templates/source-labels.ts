import type { PortableTemplateOrigin } from "../../shared/templates/portable/registry.js";

export function portableSourceLabel(origin: PortableTemplateOrigin): string {
  if (origin.kind === "upload") return origin.name;
  if (origin.kind === "authoring") return origin.draftId;
  const source = origin.source;
  const name = source.kind === "zip-upload" ? source.name : `${source.repository} @ ${source.commit.slice(0, 12)}`,
    root = [source.kind === "github" ? source.root : "", origin.root].filter(Boolean).join("/");
  return root ? `${name} / ${root}` : name;
}
