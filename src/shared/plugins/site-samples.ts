import type { BuildEngine, BuildInput } from "../builds/contracts.js";
import type { BuildRun } from "../builds/run.js";
import type { BuildThemeMetadata } from "../builds/theme.js";
import { packageRecord, packageText } from "./validation.js";
import { PluginPackageError } from "./contracts.js";

export const SITE_SAMPLE_RUNNER = "static-site-samples/v2";
export type SiteSampleSource =
  | { kind: "catalog"; engine: BuildEngine; reference: string }
  | { kind: "draft"; id: string; revision: number; fixtureId: string };
export interface SiteSampleRequest {
  id: string;
  source: SiteSampleSource;
}
export interface SiteSampleContext {
  source: SiteSampleSource;
  runnerVersion: string;
  engineVersion: string;
  fixtureId: string;
  definitionDigest?: string;
  packageDigest?: string;
}
/** Sample records contain execution identity and provenance, never registry credentials or project state. */
export interface SiteSampleBuild extends BuildRun {
  key: string;
  context: SiteSampleContext;
  theme: BuildThemeMetadata;
  site: BuildInput["site"];
}
const uuid = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new PluginPackageError("invalidPackage");
  return value;
};
export function siteSampleRequest(value: unknown): SiteSampleRequest {
  const input = packageRecord(value, ["id", "source"]);
  return { id: uuid(input.id), source: siteSampleSource(input.source) };
}
export function siteSampleSource(value: unknown): SiteSampleSource {
  const raw = packageRecord(value, ["kind", "engine", "reference", "id", "revision", "fixtureId"]);
  let source: SiteSampleSource;
  if (raw.kind === "catalog") {
    packageRecord(raw, ["kind", "engine", "reference"]);
    if (raw.engine !== "hexo" && raw.engine !== "docusaurus") throw new PluginPackageError("invalidPackage");
    const reference = packageText(raw.reference, 100);
    if (!/^[a-z][a-z0-9.-]{1,63}@[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(reference))
      throw new PluginPackageError("invalidPackage");
    source = { kind: "catalog", engine: raw.engine, reference };
  } else if (raw.kind === "draft") {
    packageRecord(raw, ["kind", "id", "revision", "fixtureId"]);
    if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1) throw new PluginPackageError("invalidPackage");
    source = {
      kind: "draft",
      id: uuid(raw.id),
      revision: Number(raw.revision),
      fixtureId: packageText(raw.fixtureId, 80),
    };
  } else throw new PluginPackageError("invalidPackage");
  return source;
}
