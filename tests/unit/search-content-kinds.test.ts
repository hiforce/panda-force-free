import { expect, test } from "bun:test";
import { DEFAULT_SEARCH_SETTINGS, searchContentKinds, searchSettings } from "../../src/shared/search/validation.js";
import { savedSourceUrl } from "../../src/shared/content-sources/links.js";

test("legacy full-text rules stay document-only without changing their serialized metadata", () => {
  const original = JSON.stringify(DEFAULT_SEARCH_SETTINGS),
    parsed = searchSettings(JSON.parse(original));
  expect(JSON.stringify(parsed)).toBe(original);
  expect(searchContentKinds(parsed.contentKinds)).toEqual(["document"]);
  expect(Object.hasOwn(parsed, "contentKinds")).toBe(false);
});

test("explicit original kinds have closed canonical values and never widen knowledge rules", () => {
  const input = { ...structuredClone(DEFAULT_SEARCH_SETTINGS), contentKinds: ["web", "document", "slides"] };
  const parsed = searchSettings(input);
  expect(parsed.contentKinds).toEqual(["document", "slides", "web"]);
  expect(input.contentKinds).toEqual(["web", "document", "slides"]);
  expect(parsed.knowledge).toEqual(DEFAULT_SEARCH_SETTINGS.knowledge);
  for (const value of [null, [], ["web", "web"], ["skill"], "web", ["document", "slides", "web", "image"]])
    expect(() => searchSettings({ ...DEFAULT_SEARCH_SETTINGS, contentKinds: value })).toThrow();
});

test("original links use distinct real readers, encoded identities and pinned native versions", () => {
  expect(savedSourceUrl("project-1", "doc-1")).toBe("/documents?project=project-1&document=doc-1");
  expect(savedSourceUrl("personal", "c-1", "web", "v1")).toBe("/create?asset=c-1&assetVersion=v1");
  expect(savedSourceUrl("project-1", "c-2", "slides", "v2")).toBe("/project?id=project-1&asset=c-2&assetVersion=v2");
});
