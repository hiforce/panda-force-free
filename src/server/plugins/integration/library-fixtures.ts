import { parseContent } from "../../publishing/content/parse.js";
import { transformContent } from "../../publishing/variant-transform.js";
import { builtinFormats } from "../../publishing/adapters/builtin-formats.js";
import { canonicalPackageJson, packageSha256 } from "../../../shared/plugins/validation.js";
import type { TemplateFixtureRunner } from "../ports.js";
import type { TemplateDefinition, TemplateFixture, TemplateFixturePreview } from "../../../shared/plugins/library.js";
import { SITE_SAMPLE_RUNNER } from "../../../shared/plugins/site-samples.js";

/** Fixed sample rendering reuses the production formatters and has no publication or network port. */
export function templateFixtureRunner(
  sitePreview?: (definition: TemplateDefinition, fixture: TemplateFixture) => Promise<TemplateFixturePreview>,
): TemplateFixtureRunner {
  const formats = builtinFormats();
  return {
    version: "builtin-content-fixtures/1" + (sitePreview ? "+" + SITE_SAMPLE_RUNNER : ""),
    async preview(definition, fixture) {
      if (fixture.kind === "site" && sitePreview) return sitePreview(definition, fixture);
      if (fixture.kind === "site")
        return {
          fixtureId: fixture.id,
          state: "requiresBuild",
          actualDigest: null,
          expectedDigest: fixture.expectedDigest,
          issues: [{ code: "sitePreviewRequiresBuild", severity: "warning" }],
          html: "",
          text: "",
          posts: [],
        };
      const entry = definition.package.manifest.channelTemplates.find((item) => item.id === fixture.exportId)!,
        formatter = formats.get(fixture.format!)!;
      const ir = parseContent({
        documentId: "fixture:" + fixture.id,
        revisionId: "fixture:" + fixture.id,
        engine: fixture.engine,
        title: fixture.title,
        locale: fixture.locale,
        content: fixture.content,
      });
      const variant = transformContent(
        ir,
        fixture.format!,
        {
          id: definition.package.manifest.id + "." + entry.id,
          version: definition.package.manifest.version,
          style: { ...entry.style, version: definition.package.manifest.version },
        },
        formatter,
      );
      const snapshot = {
        formatterVersion: variant.formatterVersion,
        html: variant.html,
        text: variant.text,
        posts: variant.posts,
        issues: variant.issues,
      };
      const actualDigest = await packageSha256(canonicalPackageJson(snapshot));
      const state = variant.issues.some((issue) => issue.severity === "blocking")
        ? "blocked"
        : fixture.expectedDigest === null
          ? "unreviewed"
          : fixture.expectedDigest === actualDigest
            ? "passed"
            : "mismatch";
      return {
        fixtureId: fixture.id,
        state,
        actualDigest,
        expectedDigest: fixture.expectedDigest,
        issues: variant.issues.map(({ code, severity }) => ({ code, severity })),
        html: variant.html,
        text: variant.text,
        posts: variant.posts,
      };
    },
  };
}
