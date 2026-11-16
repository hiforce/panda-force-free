/** A self-contained declarative package exercises authoring without private files or channel accounts. */
export function exampleTemplateDefinition(version = "1.0.0") {
  return {
    schema: 1,
    package: {
      schema: 1,
      manifest: {
        schema: 1,
        id: "example.editorial",
        version,
        name: "Editorial library",
        description: "A fixed sample package.",
        permissions: ["content:templates"],
        siteThemes: [],
        channelTemplates: [
          {
            id: "paper",
            name: "Paper",
            description: "Quiet long-form formatting.",
            formats: ["html"],
            style: { font: "Georgia,serif", color: "#222222", accent: "#884422", width: "720px", size: "17px" },
          },
        ],
      },
      files: [],
    },
    archive: {
      author: "Fixture author",
      license: "MIT",
      licenseText: "Fixture license text.",
      sourceUrl: "https://example.test/themes",
      sourceRevision: "v1",
      changelog: "Initial fixture version.",
      compatibility: "HTML channel formatting.",
    },
    fixtures: [
      {
        id: "core",
        name: "Core content",
        kind: "channel",
        exportId: "paper",
        engine: "markdown",
        locale: "en",
        title: "A sample article",
        content:
          "# A sample\n\nA **clear** statement.\n\n> A preserved quote.\n\n```js\nconst safe = true;\n```\n\n[Reference](https://example.test/reference)\n",
        format: "html",
        expectedDigest: null,
      },
    ],
  };
}
