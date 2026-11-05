import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";

const elements = new Map();
function markup(source) {
  if (!source.includes("id=")) return;
  const window = new JSDOM(source).window;
  for (const element of window.document.querySelectorAll("[id]")) {
    if (!element.id.includes("PANDA_DYNAMIC")) elements.set("#" + element.id, element.localName);
  }
  window.close();
}
markup(readFileSync("public/index.html", "utf8"));
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(directory + "/" + entry.name) : [directory + "/" + entry.name],
  );
for (const file of walk("src/client").filter((file) => file.endsWith(".js"))) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const tags = new Map();
  function collect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === "document.createElement" &&
      ts.isStringLiteral(node.initializer.arguments[0])
    )
      tags.set(node.name.text, node.initializer.arguments[0].text);
    ts.forEachChild(node, collect);
  }
  collect(source);
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) markup(node.text);
    if (ts.isTemplateExpression(node))
      markup(node.head.text + node.templateSpans.map((span) => "PANDA_DYNAMIC" + span.literal.text).join(""));
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "id" &&
      ts.isStringLiteral(node.right) &&
      tags.has(node.left.expression.getText(source))
    )
      elements.set("#" + node.right.text, tags.get(node.left.expression.getText(source)));
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const source =
  "// Generated from interface templates by scripts/quality/dom-types.mjs.\nexport interface InterfaceElements {\n" +
  [...elements]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, tag]) => `  ${JSON.stringify(id)}: HTMLElementTagNameMap[${JSON.stringify(tag)}];`)
    .join("\n") +
  '\n}\nexport type SelectedElement<S extends string> = S extends keyof InterfaceElements ? InterfaceElements[S] : S extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[S] : S extends `${infer T extends keyof HTMLElementTagNameMap}${"[" | "." | "#"}${string}` ? HTMLElementTagNameMap[T] : S extends `${string}[type="submit"]${string}` ? HTMLButtonElement | HTMLInputElement : HTMLElement;\n';
const path = "src/client/dom-elements.d.ts";
if (process.argv.includes("--write")) writeFileSync(path, source);
else if (readFileSync(path, "utf8") !== source)
  throw new Error("Interface element types are stale; run bun scripts/quality/dom-types.mjs --write");
