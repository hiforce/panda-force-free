import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { interfaceStyleFiles, inspectInterfaceStyles } from "../../scripts/quality/interface-styles.mjs";

test("interface style boundaries reject independent gutters and palette overrides", () => {
  const source = Object.fromEntries(interfaceStyleFiles.map((file) => [file, readFileSync(file, "utf8")]));
  expect(inspectInterfaceStyles(source).failures).toEqual([]);
  for (const violation of [
    ".settings-page { padding: 40px; }",
    ".settings-page { padding-inline: 60px; }",
    ".settings-field { color: #123456; }",
    ".topbar { height: 93px; }",
    ".settings-row { display: block !important; }",
    ":root { --pf-page-padding: 91px; }",
    ":root { --workspace-document-width: 800px; }",
    ".settings-content { scrollbar-color: gray black; }",
  ]) {
    const invalid = { ...source, "public/settings-workspace.css": source["public/settings-workspace.css"] + violation };
    expect(inspectInterfaceStyles(invalid).failures.length).toBeGreaterThan(0);
  }
  expect(
    inspectInterfaceStyles({
      ...source,
      "public/workbench.css": source["public/workbench.css"] + ".window-brand { display: none !important; }",
    }).failures.length,
  ).toBeGreaterThan(0);
  expect(
    inspectInterfaceStyles({
      ...source,
      "public/workbench-layout.css":
        source["public/workbench-layout.css"] + ".panda-workspace .conversation-shell { container-type: inline-size; }",
    }).failures.length,
  ).toBeGreaterThan(0);
});
