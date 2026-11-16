export type LocalizedTemplateText = Readonly<Record<string, string>>;
export type TemplateParameter = { id: string; label: LocalizedTemplateText; required: boolean } & (
  | { type: "text"; maxLength?: number; default?: string }
  | { type: "number"; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean"; default?: boolean }
  | { type: "choice"; options: readonly { value: string; label: LocalizedTemplateText }[]; default?: string }
);
export interface PortableTemplateManifest {
  schemaVersion: 1;
  kind: "panda-force.template";
  id: string;
  version: string;
  templateType: string;
  categories: readonly string[];
  name: LocalizedTemplateText;
  description: LocalizedTemplateText;
  publisher: { name: string; homepage?: string };
  license: { expression: string; file: string };
  tags: readonly string[];
  parameters: readonly TemplateParameter[];
  payload: { format: string; path: string };
  requires: {
    adapters: readonly { id: string; api: number }[];
    skills: readonly { packageId: string; exportId: string; version: string; digest: string }[];
  };
  composition: { slots: readonly { id: string; policy: "single" | "ordered" | "merge" }[] };
  previews: readonly string[];
  files: readonly { path: string; sha256: string; bytes: number; mediaType: string }[];
}
export interface TemplateLibraryEntry {
  id: string;
  version: string;
  templateType: string;
  categories: readonly string[];
  name: LocalizedTemplateText;
  description: LocalizedTemplateText;
  manifest: string;
  sha256: string;
}
export interface PortableTemplateIndex {
  schemaVersion: 1;
  kind: "panda-force.template-library";
  id: string;
  name: LocalizedTemplateText;
  entries: readonly TemplateLibraryEntry[];
}
export interface TemplateResource {
  path: string;
  bytes: Uint8Array;
}
export interface TemplateResourcePolicy {
  manifestBytes: number;
  payloadBytes: number;
  fileBytes: number;
  totalBytes: number;
  files: number;
  templates: number;
}
/** These are transport budgets, not a universal media size encoded into the manifest contract. */
export const DEFAULT_TEMPLATE_RESOURCE_POLICY: Readonly<TemplateResourcePolicy> = Object.freeze({
  manifestBytes: 256 * 1024,
  payloadBytes: 2 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  files: 4096,
  templates: 256,
});
export type ImmutableTemplate<T> = T extends object ? { readonly [K in keyof T]: ImmutableTemplate<T[K]> } : T;
export interface VerifiedPortableTemplate {
  readonly manifest: ImmutableTemplate<PortableTemplateManifest>;
  readonly manifestSha256: string;
  readonly digest: string;
  readonly byteLength: number;
  readManifest(): Uint8Array;
  read(path: string): Uint8Array;
  text(path: string): string;
}
export interface VerifiedTemplateLibrary {
  readonly index: ImmutableTemplate<PortableTemplateIndex>;
  readonly templates: readonly VerifiedPortableTemplate[];
  readonly byteLength: number;
}
