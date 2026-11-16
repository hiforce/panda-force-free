import { expect, test } from "bun:test";
import { CreativeTextCache } from "../../src/server/creative/assets/text-cache.js";

test("the disposable parser cache enforces both entry and serialized-byte budgets", () => {
  const cache = new CreativeTextCache(220, 2),
    value = (text: string) => ({ text, sections: [{ id: "s", start: 0, end: text.length }] });
  cache.put("a", value("First"));
  cache.put("b", value("Second"));
  expect(cache.get("a")?.text).toBe("First");
  cache.put("c", value("Third"));
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")?.text).toBe("First");
  cache.put("large", value("x".repeat(300)));
  expect(cache.get("large")).toBeUndefined();
  cache.put("d", value("y".repeat(120)));
  expect(cache.get("c")).toBeUndefined();
  expect(cache.get("a")).toBeUndefined();
  cache.clear();
  expect(cache.get("d")).toBeUndefined();
});
