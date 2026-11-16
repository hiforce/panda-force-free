import { expect, test } from "bun:test";
import { knowledgeSelection } from "../../src/shared/knowledge/task-validation.js";
import { knowledgeSourceBinding } from "../../src/shared/knowledge/source-binding.js";
import { knowledgeSourceMetadata } from "../../src/server/knowledge/tasks/record.js";

const id = "c-00000000-0000-0000-0000-000000000001";
const binding = () => ({
  kind: "web" as const,
  path: `creations/${id}.panda.json`,
  blob: "a".repeat(40),
  original: { name: "index.html", digest: "b".repeat(64), size: 128 },
  resources: [],
});
test("knowledge selection preserves historical absent kinds and copies only explicit bounded native choices", () => {
  expect(knowledgeSelection({ project: "project-1", ids: [id] })).toEqual({ project: "project-1", ids: [id] });
  const kinds = ["web", "document"],
    value = knowledgeSelection({ project: "project-1", ids: [id], contentKinds: kinds });
  kinds[0] = "slides";
  expect(value.contentKinds).toEqual(["document", "web"]);
  for (const contentKinds of [[], ["other"], ["web", "web"]])
    expect(() => knowledgeSelection({ project: "project-1", ids: [id], contentKinds })).toThrow();
});
test("native evidence bindings are closed, typed and bounded without accepting document-shaped substitutes", () => {
  expect(knowledgeSourceBinding(binding(), id)).toEqual(binding());
  for (const value of [
    { ...binding(), kind: "document" },
    { ...binding(), path: "../private" },
    { ...binding(), blob: "a".repeat(64) },
    { ...binding(), original: { ...binding().original, name: "../original.html" } },
    { ...binding(), resources: [{ name: "INDEX.HTML", digest: "c".repeat(64), size: 1 }] },
    { ...binding(), original: { ...binding().original, size: 3 * 1024 * 1024 } },
    { ...binding(), unexpected: "field" },
  ])
    expect(() => knowledgeSourceBinding(value, id)).toThrow();
  expect(() =>
    knowledgeSourceMetadata({
      id,
      version: "b".repeat(64),
      kind: "user-input",
      title: "User statement",
      binding: binding(),
    }),
  ).toThrow();
  const legacy = { id: "doc-1", version: "saved-revision", kind: "asset" as const, title: "Historical saved document" };
  expect(knowledgeSourceMetadata(legacy)).toEqual(legacy);
});
