import { expect, test } from "bun:test";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { documentJavaLanguage } from "../../src/client/documents/code-block/java.js";
test("Java declarations distinguish classes, methods and constructors while preserving literals and comments", () => {
  const source =
      'public class Animal {\n // A pet\n private String name = "Panda";\n public Animal() {}\n public String speak() { return name; }\n public int age = 3;\n}',
    found: { text: string; style: string }[] = [];
  highlightTree(
    documentJavaLanguage.parser.parse(source),
    tagHighlighter([
      { tag: tags.keyword, class: "keyword" },
      { tag: tags.typeName, class: "type" },
      { tag: tags.className, class: "type" },
      { tag: tags.function(tags.variableName), class: "function" },
      { tag: tags.string, class: "string" },
      { tag: tags.comment, class: "comment" },
      { tag: tags.number, class: "number" },
    ]),
    (from, to, style) => found.push({ text: source.slice(from, to), style }),
  );
  expect(found).toContainEqual({ text: "Animal", style: "type" });
  expect(found).toContainEqual({ text: "Animal", style: "function" });
  expect(found).toContainEqual({ text: "speak", style: "function" });
  expect(found).toContainEqual({ text: '"Panda"', style: "string" });
  expect(found).toContainEqual({ text: "3", style: "number" });
  expect(found).toContainEqual({ text: "// A pet", style: "comment" });
});
