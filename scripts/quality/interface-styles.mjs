import { readFileSync } from "node:fs";

export const interfaceStyleFiles = [
  "public/workbench-layout.css",
  "public/workbench.css",
  "public/gadget.css",
  "public/workbench-forms.css",
  "public/knowledge.css",
  "public/cli.css",
  "public/bots.css",
  "public/database.css",
  "public/settings-workspace.css",
  "public/creative.css",
  "public/creation.css",
  "public/appearance.css",
  "public/style.css",
  "public/packages.css",
  "public/session-workspace.css",
  "public/document-workspace.css",
  "public/document-authoring.css",
  "public/file-preview.css",
];

/** Checks the active shell and feature stylesheet boundaries, not visual taste. */
export function inspectInterfaceStyles(files) {
  const failures = [];
  const owner = "public/workbench-layout.css";
  const tokens = [
    "--pf-page-padding",
    "--pf-page-padding-inline",
    "--workspace-sidebar-default-width",
    "--workspace-sidebar-min-width",
    "--workspace-sidebar-max-width",
    "--workspace-content-min-width",
    "--workspace-session-width",
    "--workspace-document-width",
    "--workspace-settings-width",
    "--workspace-template-width",
  ];
  for (const token of tokens) {
    if (!new RegExp(token + "\\s*:").test(files[owner] || "")) failures.push(`${owner}: missing ${token}`);
    for (const [file, css] of Object.entries(files))
      if (file !== owner && new RegExp(token + "\\s*:").test(css))
        failures.push(`${file}: shell token ${token} has another owner`);
  }
  for (const [file, css] of Object.entries(files)) {
    if (file !== "public/workbench.css" && /scrollbar-(?:color\s*:|width\s*:\s*(?:thin|auto))/.test(css))
      failures.push(`${file}: visible scroll styling belongs to the shared workbench stylesheet`);
    if (file !== "public/appearance.css" && /--pf-scrollbar-[\w-]+\s*:/.test(css))
      failures.push(`${file}: scrollbar palette and size tokens belong to appearance.css`);
  }
  for (const file of [
    "public/settings-workspace.css",
    "public/creative.css",
    "public/gadget.css",
    "public/creation.css",
    "public/bots.css",
    "public/database.css",
    owner,
  ]) {
    const css = (files[file] || "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/#[a-f\d]{3,8}\b/i.test(css)) failures.push(`${file}: feature color must use a semantic token`);
    for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (declarations.includes("!important") && !selector.includes("[hidden]"))
        failures.push(`${file}: specificity escalation outside the hidden-state contract`);
      if (file !== owner && /\.(?:app-shell|topbar|workspace-sidebar-resizer)\b/.test(selector))
        failures.push(`${file}: global shell geometry belongs to ${owner}`);
      if (selector.trim() === ".panda-workspace .conversation-shell" && /container-type\s*:/.test(declarations))
        failures.push(
          `${file}: size containment must stay scoped to reading layouts to preserve editor overlay coordinates`,
        );
    }
  }
  for (const [, selectors, declarations] of (files["public/workbench.css"] || "").matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if (
      selectors.split(",").some((selector) => /\.(?:window-brand|top-actions)\s*$/.test(selector)) &&
      declarations.includes("!important")
    )
      failures.push(
        "public/workbench.css: legacy header override prevents the shell from owning responsive visibility",
      );
  for (const [file, selector] of [
    ["public/workbench.css", ".workbench-view"],
    ["public/settings-workspace.css", ".settings-page"],
  ]) {
    const css = (files[file] || "").replace(/\/\*[\s\S]*?\*\//g, "");
    let found = false;
    for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectors.split(",").some((entry) => entry.trim() === selector)) continue;
      for (const [, property, value] of declarations.matchAll(/\b(padding(?:-[a-z-]+)?)\s*:\s*([^;]+);/g)) {
        found = true;
        const expected = property === "padding-inline" ? "var(--pf-page-padding-inline)" : "var(--pf-page-padding)";
        if (value.trim() !== expected) failures.push(`${file}: ${selector} ${property} must share the page gutter`);
      }
    }
    if (!found) failures.push(`${file}: page gutter contract is missing for ${selector}`);
  }
  const selectOwned = [...(files["public/workbench-forms.css"] || "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    ([, selectors, declarations]) =>
      selectors.split(",").some((selector) => selector.trim() === ".wb-select") &&
      declarations.includes("appearance: none"),
  );
  if (!selectOwned) failures.push("Shared select component is missing");
  return { checked: Object.keys(files).length, failures };
}

export function auditInterfaceStyles() {
  return inspectInterfaceStyles(
    Object.fromEntries(interfaceStyleFiles.map((file) => [file, readFileSync(file, "utf8")])),
  );
}

if (import.meta.main) {
  const report = auditInterfaceStyles();
  console.log(JSON.stringify(report));
  if (report.failures.length) process.exitCode = 1;
}
