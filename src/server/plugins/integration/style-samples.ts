import type { ChannelTemplateMetadataCatalog } from "../presentation-ports.js";
import type { PublicationFormat } from "../../../shared/publishing/content.js";
import { parseContent } from "../../publishing/content/parse.js";
import { transformContent } from "../../publishing/variant-transform.js";
import { builtinFormats } from "../../publishing/adapters/builtin-formats.js";
import { canonicalPackageJson, packageSha256 } from "../../../shared/plugins/validation.js";
import type { TemplateFixturePreview } from "../../../shared/plugins/library.js";
import { PluginRegistryError } from "../errors.js";
import { PUBLIC_STYLE_SAMPLE } from "../../../shared/presentation/sample-content.js";

/** Catalog samples contain fixed public text; this adapter has no document or delivery port. */
export async function renderStyleSample(
  templates: ChannelTemplateMetadataCatalog,
  id: string,
  version: string,
  format: PublicationFormat,
): Promise<TemplateFixturePreview> {
  const template = (await templates.list()).find((item) => item.id === id && item.version === version);
  const formatter = builtinFormats().get(format);
  if (!template || !formatter || !template.formats.includes(format))
    throw new PluginRegistryError("invalidLibraryDraft");
  const content = parseContent({
    documentId: "style-sample",
    revisionId: "style-sample",
    engine: "markdown",
    ...PUBLIC_STYLE_SAMPLE,
  });
  const variant = transformContent(content, format, template, formatter);
  const actualDigest = await packageSha256(
    canonicalPackageJson({
      formatterVersion: variant.formatterVersion,
      html: variant.html,
      text: variant.text,
      posts: variant.posts,
      issues: variant.issues,
    }),
  );
  return {
    fixtureId: "style-sample",
    state: variant.issues.some((issue) => issue.severity === "blocking") ? "blocked" : "unreviewed",
    actualDigest,
    expectedDigest: null,
    issues: variant.issues.map(({ code, severity }) => ({ code, severity })),
    html: variant.html,
    text: variant.text,
    posts: variant.posts,
  };
}
