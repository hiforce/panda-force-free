export const SKILL_CATEGORIES = ["research", "writing", "image", "slides", "video", "web"] as const;
export const SKILL_OUTPUTS = ["document", "image", "slides", "video", "web"] as const;
export const SKILL_CAPABILITIES = [
  "project.documents.read",
  "project.documents.create",
  "project.documents.propose-update",
  "project.assets.read",
  "research.web",
  "generate.image",
  "generate.slides",
  "generate.video",
  "generate.web",
] as const;
export const SKILL_LIMITS = Object.freeze({
  archiveBytes: 16 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
  manifestBytes: 256 * 1024,
  instructionBytes: 64 * 1024,
  taskInstructionBytes: 256 * 1024,
  files: 512,
  exports: 64,
  selections: 64,
});
export const SKILL_BUNDLE_BYTES = 48 * 1024 * 1024;
export type SkillOutput = (typeof SKILL_OUTPUTS)[number];
export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];
export type LocalizedSkillText = Readonly<Record<string, string>>;
export type SkillParameter = {
  id: string;
  label: LocalizedSkillText;
  required: boolean;
} & (
  | { type: "text"; maxLength?: number }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "choice"; options: readonly { value: string; label: LocalizedSkillText }[] }
);
export interface SkillConstraints {
  aspectRatio?: "auto" | "1:1" | "16:9" | "9:16" | "2:3" | "3:2" | "4:3" | "3:4";
  outputLocale?: string;
  brand?: string;
}
export interface SkillDefinition {
  id: string;
  category: (typeof SKILL_CATEGORIES)[number];
  role: "workflow" | "template" | "style";
  name: LocalizedSkillText;
  description: LocalizedSkillText;
  instructions: string;
  inputs: readonly { id: string; kind: "text" | "document-ref" | "asset-ref"; required: boolean }[];
  parameters: readonly SkillParameter[];
  capabilities: readonly SkillCapability[];
  outputTypes: readonly SkillOutput[];
  template?: string;
  previews?: readonly string[];
  cover?: { path: string; alt: LocalizedSkillText };
  readme?: LocalizedSkillText;
  composition: { appliesTo: readonly SkillOutput[]; conflictsWith: readonly string[]; constraints: SkillConstraints };
  entitlement?: { issuer: string; product: string };
}
export interface SkillPackManifest {
  schemaVersion: 1;
  kind: "panda-force.skill-pack";
  id: string;
  version: string;
  name: LocalizedSkillText;
  description: LocalizedSkillText;
  publisher: { name: string; homepage?: string };
  repository?: string;
  license: { expression: string; file: string };
  requires: { skillApi: 1; pandaForce?: { min?: string; maxExclusive?: string } };
  files: readonly string[];
  skills: readonly SkillDefinition[];
}
export interface SkillResource {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface SkillResourceStamp {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export type ImmutableSkillData<T> = T extends object ? { readonly [K in keyof T]: ImmutableSkillData<T[K]> } : T;
/** Resource readers return copies; callers cannot change previously verified content. */
export interface VerifiedSkillPack {
  readonly manifest: ImmutableSkillData<SkillPackManifest>;
  readonly manifestSha256: string;
  readonly digest: string;
  readonly resources: readonly SkillResourceStamp[];
  readonly byteLength: number;
  readManifest(): Uint8Array;
  read(path: string): Uint8Array;
  text(path: string): string;
}
