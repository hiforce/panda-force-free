export default {
  guides: [
    "overview",
    "features",
    { type: "category", label: "Getting started", items: ["installation", "kubernetes", "workspace"] },
    {
      type: "category",
      label: "Use cases",
      items: ["bot-workspace", "bot-api-quickstart", "bot-product-publishing", "bot-task-lifecycle"],
    },
    {
      type: "category",
      label: "Administration",
      items: [
        "configuration",
        "harness-runtimes",
        "model-providers",
        "cluster",
        "storage",
        "security",
        "troubleshooting",
      ],
    },
    { type: "category", label: "Development", items: ["building", "base-images", "cdn-build", "releases", "updates"] },
  ],
};
