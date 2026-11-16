import type { ProjectSpaceFile } from "../../src/server/project-content/space-file.js";
import type { SiteSourceProfile, SiteEdition } from "../../src/shared/sites/profile.js";

export function projectSpaceFixture(id = "space-1", library = false): ProjectSpaceFile {
  return {
    schema: 1,
    sourceProfile: null,
    space: {
      id,
      projectId: "project-1",
      code: library ? "__documents__" : id,
      name: library ? "Project documents" : "Publication " + id,
      engine: library ? "markdown" : "hexo",
      theme: "default",
      sourceMode: "managed",
      sourceRoot: "/isolated/sources/" + id,
      locale: "en",
      version: 1,
      createdAt: 100,
      updatedAt: 100,
    },
  };
}
export function projectSpaceProfile(large = false): SiteSourceProfile {
  let config: SiteEdition["config"] = { description: "A test publication" };
  if (large)
    config = { theme_config: Object.fromEntries(Array.from({ length: 7 }, (_, n) => ["field" + n, "x".repeat(7000)])) };
  return {
    schema: 1,
    engine: "hexo",
    imageMode: "managed",
    localizedImages: {},
    resources: [],
    editions: Object.fromEntries(
      (large ? ["en", "de", "fr", "es", "it", "ja", "ko", "zh", "ru", "pl", "pt", "nl"] : ["en"]).map((locale) => [
        locale,
        {
          title: "Example site",
          url: "https://example.test",
          basePath: "/",
          config,
        },
      ]),
    ),
  };
}
