import type { PluginPackage, PluginManifest } from "./contracts.js";
import type { PublicationFormat } from "../publishing/content.js";

export interface TemplateArchive {
  author: string;
  license: string;
  licenseText: string;
  sourceUrl: string;
  sourceRevision: string;
  changelog: string;
  compatibility: string;
}
export interface TemplateFixture {
  id: string;
  name: string;
  kind: "channel" | "site";
  exportId: string;
  engine: "markdown" | "hexo" | "docusaurus";
  locale: string;
  title: string;
  content: string;
  format?: PublicationFormat;
  /** A baseline is accepted explicitly; generating a preview never approves its output. */
  expectedDigest: string | null;
}
export type TemplateArchiveSummary = Pick<TemplateArchive, "author" | "license" | "sourceUrl" | "sourceRevision">;
export const templateArchiveSummary = (value: TemplateArchive): TemplateArchiveSummary => ({
  author: value.author,
  license: value.license,
  sourceUrl: value.sourceUrl,
  sourceRevision: value.sourceRevision,
});
export interface TemplateDefinition {
  schema: 1;
  package: PluginPackage;
  archive: TemplateArchive;
  fixtures: TemplateFixture[];
}
export interface TemplateFixtureResult {
  fixtureId: string;
  state: "passed" | "unreviewed" | "mismatch" | "blocked" | "requiresBuild";
  actualDigest: string | null;
  expectedDigest: string | null;
  issues: { code: string; severity: "info" | "warning" | "blocking" }[];
  siteEvidence?: {
    runId: string;
    inputHash: string;
    runnerVersion: string;
    engineVersion: string;
    image: import("../builds/run.js").BuildRun["image"];
  };
}
export interface TemplateValidation {
  definitionDigest: string;
  runnerVersion: string;
  checkedAt: number;
  results: TemplateFixtureResult[];
  missingCoverage: string[];
  passed: boolean;
}
export interface TemplateValidationSummary {
  definitionDigest: string;
  runnerVersion: string;
  checkedAt: number;
  passed: boolean;
  total: number;
  passedCount: number;
  missingCoverageCount: number;
}
export const templateValidationSummary = (value: TemplateValidation): TemplateValidationSummary => ({
  definitionDigest: value.definitionDigest,
  runnerVersion: value.runnerVersion,
  checkedAt: value.checkedAt,
  passed: value.passed,
  total: value.results.length,
  passedCount: value.results.filter((item) => item.state === "passed").length,
  missingCoverageCount: value.missingCoverage.length,
});
export interface TemplateDraftSummary {
  id: string;
  revision: number;
  digest: string;
  packageDigest: string;
  manifest: PluginManifest;
  archive: TemplateArchiveSummary;
  fixtureCount: number;
  validation: TemplateValidationSummary | null;
  publishedAt: number | null;
  updatedAt: number;
  updatedBy: string;
}
export interface TemplateDraft extends Omit<TemplateDraftSummary, "validation"> {
  definition: TemplateDefinition;
  archive: TemplateArchive;
  validation: TemplateValidation | null;
}
export interface TemplateRelease {
  id: string;
  version: string;
  digest: string;
  packageDigest: string;
  definition: TemplateDefinition;
  validation: TemplateValidation;
  publishedAt: number;
  publishedBy: string;
}
export interface TemplateReleaseSummary extends Omit<TemplateRelease, "definition" | "validation"> {
  manifest: PluginManifest;
  archive: TemplateArchiveSummary;
  validation: TemplateValidationSummary;
}
export interface TemplateLibrarySnapshot {
  drafts: TemplateDraftSummary[];
  releases: TemplateReleaseSummary[];
}
export interface TemplateFixturePreview extends TemplateFixtureResult {
  html: string;
  text: string;
  posts: { text: string; weightedLength: number; valid: boolean }[];
  siteBuild?: Pick<import("./site-samples.js").SiteSampleBuild, "id" | "phase" | "error" | "artifactAvailable">;
  sitePages?: string[];
}
export interface TemplateDraftPreview extends TemplateFixturePreview {
  definitionDigest: string;
  draftRevision: number;
}
export const TEMPLATE_LIBRARY_LIMITS = Object.freeze({
  drafts: 32,
  draftBytes: 64 * 1024 * 1024,
  releaseBytes: 128 * 1024 * 1024,
  jsonBytes: 14 * 1024 * 1024,
  fixtures: 256,
  sourceBytes: 1024 * 1024,
});
