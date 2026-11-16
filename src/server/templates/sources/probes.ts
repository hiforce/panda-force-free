import type { TemplateSourceCandidate } from "../../../shared/templates/sources/contracts.js";
import { TemplateSourceIndex, sourceRecord, sourceRootEligible, sourcePathAt, sourceModuleEntry } from "./index.js";
import {
  NATIVE_THEME_BUNDLE_FILE,
  NATIVE_THEME_BUNDLE_SCHEMA,
  NATIVE_THEME_BUNDLE_METADATA_BYTES,
} from "../../../shared/templates/native/bundle.js";

export type TemplateSourceProbe = (index: TemplateSourceIndex) => Iterable<TemplateSourceCandidate>;
const dependencies = (value: Record<string, unknown>) => ({
  ...(sourceRecord(value.dependencies) ? value.dependencies : {}),
  ...(sourceRecord(value.peerDependencies) ? value.peerDependencies : {}),
  ...(sourceRecord(value.devDependencies) ? value.devDependencies : {}),
});

function* hexo(index: TemplateSourceIndex): Iterable<TemplateSourceCandidate> {
  for (const file of index.files) {
    if (!sourceRootEligible(file.path) || !/\.(?:ejs|njk|nunjucks|swig|pug|jade|hbs|handlebars|html)$/i.test(file.path))
      continue;
    const parts = file.path.split("/");
    for (let i = 0; i < parts.length - 1; i++)
      if (parts[i] === "layout") yield index.candidate("hexo-theme", parts.slice(0, i).join("/"), [file.path]);
  }
  for (const file of index.entries("package.json")) {
    const value = index.metadata(file.path);
    if (value && ("hexo" in dependencies(value) || sourceRecord(value.hexo)) && index.has(file.root, "_config.yml"))
      yield index.candidate("hexo-site", file.root, [file.path, sourcePathAt(file.root, "_config.yml")], value.name);
  }
}
function* docusaurus(index: TemplateSourceIndex): Iterable<TemplateSourceCandidate> {
  for (const file of index.entries("package.json")) {
    const value = index.metadata(file.path);
    if (!value) continue;
    const deps = dependencies(value),
      config = ["docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs", "docusaurus.config.cjs"].find(
        (path) => index.has(file.root, path),
      );
    if ("@docusaurus/core" in deps && config)
      yield index.candidate("docusaurus-site", file.root, [file.path, sourcePathAt(file.root, config)], value.name);
    const themeName = typeof value.name === "string" && /^(?:@docusaurus\/theme-|docusaurus-theme-)/.test(value.name),
      keyword = Array.isArray(value.keywords) && value.keywords.includes("docusaurus-theme");
    if (!themeName && !("@docusaurus/core" in deps && keyword)) continue;
    const theme = ["theme", "lib/theme", "src/theme"]
      .map((path) => index.under(file.root, path))
      .find((files) => files.length);
    const entry = sourceModuleEntry(index, file.root, value.main);
    if (theme || entry)
      yield index.candidate(
        "docusaurus-theme",
        file.root,
        [file.path, ...(theme?.map((file) => file.path) ?? []), ...(entry ? [sourcePathAt(file.root, entry)] : [])],
        value.name,
      );
  }
}
function* portable(index: TemplateSourceIndex): Iterable<TemplateSourceCandidate> {
  for (const file of index.entries("panda-templates.json")) {
    const value = index.metadata(file.path);
    if (value?.kind === "panda-force.template-library" && value.schemaVersion === 1 && Array.isArray(value.entries))
      yield index.candidate(
        "portable-library",
        file.root,
        [file.path],
        sourceRecord(value.name) ? value.name.en : null,
      );
  }
}

function* nativeBundles(index: TemplateSourceIndex): Iterable<TemplateSourceCandidate> {
  for (const file of index.entries(NATIVE_THEME_BUNDLE_FILE)) {
    const metadata = index.metadata(file.path, NATIVE_THEME_BUNDLE_METADATA_BYTES);
    if (
      metadata?.schema !== NATIVE_THEME_BUNDLE_SCHEMA ||
      metadata.root !== "theme" ||
      !sourceRecord(metadata.settings)
    )
      continue;
    const engine = metadata.settings.engine;
    if (engine !== "hexo" && engine !== "docusaurus") continue;
    yield index.candidate(
      engine === "hexo" ? "hexo-theme" : "docusaurus-theme",
      sourcePathAt(file.root, "theme"),
      [file.path],
      sourceRecord(metadata.settings.name) ? metadata.settings.name.en : null,
    );
  }
}

/** Only application-registered probes run; an imported repository cannot register executable adapters. */
export const standardSourceProbes: readonly TemplateSourceProbe[] = Object.freeze([
  hexo,
  docusaurus,
  portable,
  nativeBundles,
]);
