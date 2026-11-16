import type { PluginPackage } from "../../src/shared/plugins/contracts.js";

export function profileThemePackage(): PluginPackage {
  return {
    schema: 1,
    manifest: {
      schema: 1,
      id: "example.profiles",
      version: "1.0.0",
      name: "Personal site styles",
      description: "",
      permissions: ["content:site-themes"],
      channelTemplates: [],
      siteThemes: [
        {
          kind: "profile",
          id: "journal",
          name: "Journal",
          description: "",
          engine: "hexo",
          profile: { layout: "journal", font: "serif", accent: "#845738", width: 760, density: "comfortable" },
        },
        {
          kind: "profile",
          id: "handbook",
          name: "Handbook",
          description: "",
          engine: "docusaurus",
          profile: { layout: "handbook", font: "sans", accent: "#5155d9", width: 1120, density: "compact" },
        },
      ],
    },
    files: [],
  };
}
