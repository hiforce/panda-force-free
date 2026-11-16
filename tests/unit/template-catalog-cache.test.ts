import { expect, test } from "bun:test";
import { TemplateCatalogCache } from "../../src/client/templates/catalog-cache.js";
import type { TemplateCatalogPage } from "../../src/shared/templates/catalog.js";
const page = (total: number): TemplateCatalogPage => ({ revisions: {}, templates: [], total, nextCursor: null });

test("catalog snapshots are bounded, short-lived and isolated between manager identities", () => {
  let now = 0;
  const a = new TemplateCatalogCache(() => now),
    b = new TemplateCatalogCache(() => now);
  const original = page(3);
  a.write("writing", original);
  original.total = 90;
  expect(a.read("writing")!.total).toBe(3);
  expect(b.read("writing")).toBeNull();
  const local = a.read("writing")!;
  local.total = 200;
  expect(a.read("writing")!.total).toBe(3);
  now = 30000;
  expect(a.read("writing")).toBeNull();
  for (let i = 0; i < 13; i++) a.write(String(i), page(i));
  expect(a.read("0")).toBeNull();
  expect(a.read("12")!.total).toBe(12);
  a.clear();
  expect(a.read("12")).toBeNull();
});
