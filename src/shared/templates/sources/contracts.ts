import type { SourceSnapshotDescriptor } from "../../packages/sources/snapshot.js";

export type TemplateSourceKind =
  | "hexo-theme"
  | "hexo-site"
  | "docusaurus-theme"
  | "docusaurus-site"
  | "portable-library"
  | "powerpoint-template"
  | "powerpoint-bundle";
export type TemplateSourceLocation =
  | { readonly kind: "archive" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "directory"; readonly path: string };
export interface TemplateSourceCandidate {
  readonly kind: TemplateSourceKind;
  readonly root: string;
  readonly name: string;
  readonly evidence: readonly string[];
  /** Binary formats distinguish the enclosing archive from one selected library file or a managed bundle directory. */
  readonly location?: TemplateSourceLocation;
}
export interface TemplateSourceInspection {
  readonly source: SourceSnapshotDescriptor;
  readonly sourceDigest: string;
  /** Recognition is structural evidence only; native installation and executable compatibility need their own review. */
  readonly candidates: readonly TemplateSourceCandidate[];
  readonly importableKinds: readonly TemplateSourceKind[];
  readonly issues: readonly { readonly path: string; readonly code: "metadataInvalid" | "metadataTooLarge" }[];
}
