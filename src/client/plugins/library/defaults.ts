import type { PluginPackage } from "../../../shared/plugins/contracts.js";
import type { TemplateDefinition, TemplateFixture } from "../../../shared/plugins/library.js";

const source =
  "# A sample\n\nA **clear** statement.\n\n> A preserved quote.\n\n```js\nconst safe = true;\n```\n\n[Reference](https://example.test/reference)\n";
/** Starting samples contain no project content, remote image requests or account data. */
export function templateDefinition(value?: PluginPackage): TemplateDefinition {
  const bundle = value
    ? structuredClone(value)
    : {
        schema: 1 as const,
        manifest: {
          schema: 1 as const,
          id: "example.editorial",
          version: "1.0.0",
          name: "Editorial",
          description: "",
          permissions: ["content:templates" as const],
          siteThemes: [],
          channelTemplates: [
            {
              id: "paper",
              name: "Paper",
              description: "",
              formats: ["html" as const],
              style: { font: "Georgia,serif", color: "#222222", accent: "#884422", width: "720px", size: "17px" },
            },
          ],
        },
        files: [],
      };
  const fixtures: TemplateFixture[] = [];
  for (const entry of bundle.manifest.channelTemplates)
    for (const format of entry.formats)
      fixtures.push({
        id: "sample-" + (fixtures.length + 1),
        name: entry.name + " · " + format,
        kind: "channel",
        exportId: entry.id,
        engine: "markdown",
        locale: "en",
        title: "A sample article",
        content: source,
        format,
        expectedDigest: null,
      });
  for (const entry of bundle.manifest.siteThemes)
    fixtures.push({
      id: "sample-" + (fixtures.length + 1),
      name: entry.name,
      kind: "site",
      exportId: entry.id,
      engine: entry.engine,
      locale: "en",
      title: "A sample page",
      content: source,
      expectedDigest: null,
    });
  return {
    schema: 1,
    package: bundle,
    archive: {
      author: "",
      license: "",
      licenseText: "",
      sourceUrl: "",
      sourceRevision: "",
      changelog: "",
      compatibility: "",
    },
    fixtures,
  };
}
