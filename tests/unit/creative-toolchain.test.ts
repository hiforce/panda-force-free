import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validate } from "../../scripts/build/creative-tools.mjs";

const manifest = () => JSON.parse(readFileSync("scripts/build/creative-tools/manifest.json", "utf8"));
test("creative tool profiles require platform coverage and explicit plugin dependencies", () => {
  expect(Object.keys(validate().profiles)).toEqual([
    "common",
    "slides",
    "images",
    "research",
    "writing",
    "web",
    "video",
  ]);
  const missing = manifest();
  missing.reviewedPlugins.push({ id: "new-plugin", profiles: ["missing-toolchain"] });
  expect(() => validate(missing)).toThrow("Unknown tool profile");
  const platform = manifest();
  delete platform.platforms.rocky9.slides;
  expect(() => validate(platform)).toThrow("Missing Rocky package mapping");
  expect(() => validate(manifest(), { dependencies: { pptxgenjs: "4.0.1" } })).toThrow(
    "differ from the reviewed profiles",
  );
});
