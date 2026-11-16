import type { PluginExportRef } from "../plugins/exports.js";
import type { PresentationLabel } from "../presentation/labels.js";
import type { BuildEngine } from "../builds/engines.js";
import type { PublicationFormat } from "../publishing/content.js";
import type { SkillOutput } from "../skills/contracts.js";
import type { SkillPackOrigin } from "../skills/registry.js";
import type { PortableTemplateOrigin } from "./portable/registry.js";

export type TemplateNativeReference =
  | { registry: "builtin"; kind: PluginExportRef["kind"]; id: string; version: string; digest: string }
  | { registry: "portable"; kind: "template"; id: string; version: string; digest: string }
  | { registry: "native"; kind: "site-theme"; id: string; version: string; digest: string }
  | { registry: "native-slides"; kind: "slides-template"; id: string; version: string; digest: string }
  | {
      registry: "presentation";
      kind: PluginExportRef["kind"];
      packageId: string;
      exportId: string;
      version: string;
      digest: string;
    }
  | { registry: "skills"; kind: "skill"; packageId: string; exportId: string; version: string; digest: string };
export interface ManagedTemplate {
  key: string;
  reference: TemplateNativeReference;
  templateType: string;
  categories: string[];
  label: PresentationLabel;
  artwork?: { alt: Readonly<Record<string, string>> };
  publisher: string | null;
  license: string | null;
  origin: { kind: "builtin" | "installed" } | SkillPackOrigin | PortableTemplateOrigin;
  state: { enabled: boolean; packageEnabled: boolean; exportEnabled: boolean; active: boolean; removed: boolean };
  compatibility: { engines: BuildEngine[]; formats: PublicationFormat[]; outputs: SkillOutput[] };
  /** Adapter routes describe implemented management; native services reauthorize every operation. */
  actions: {
    editor: "presentation-definition" | "portable-document" | null;
    preview: "site-build" | "channel-format" | "skill-template" | "portable-template" | null;
    export:
      | "presentation-package"
      | "builtin-copy"
      | "skill-package"
      | "portable-template"
      | "native-zip"
      | "native-slides-zip"
      | null;
    setEnabled: boolean;
    activate: boolean;
  };
}
export type TemplateRegistry = TemplateNativeReference["registry"];
export interface TemplateCatalogSourceSnapshot {
  registry: TemplateRegistry;
  revision: string;
  templates: ManagedTemplate[];
}
export interface TemplateCatalogPage {
  revisions: Partial<Record<TemplateRegistry, string>>;
  templates: ManagedTemplate[];
  total: number;
  nextCursor: string | null;
}
/** A native reference identifies authority; display names and discovery categories do not. */
export function managedTemplateKey(reference: TemplateNativeReference): string {
  const parts = "id" in reference ? [reference.id] : [reference.packageId, reference.exportId];
  return [reference.registry, reference.kind, ...parts, reference.version, reference.digest]
    .map(encodeURIComponent)
    .join(":");
}
export function sameTemplateLineage(a: TemplateNativeReference, b: TemplateNativeReference): boolean {
  if (a.registry !== b.registry || a.kind !== b.kind) return false;
  return "id" in a && "id" in b
    ? a.id === b.id
    : "packageId" in a && "packageId" in b && a.packageId === b.packageId && a.exportId === b.exportId;
}

export function templateLineageKey(reference: TemplateNativeReference): string {
  const parts = "id" in reference ? [reference.id] : [reference.packageId, reference.exportId];
  return [reference.registry, reference.kind, ...parts].map(encodeURIComponent).join(":");
}
