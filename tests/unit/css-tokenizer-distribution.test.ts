import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { rewritePreviewCss } from "../../src/server/creative/assets/preview-css.js";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

test("NJ ships the reviewed upstream tokenizer with exact declarations and license", () => {
  const prefix = "src/server/creative/assets/vendor/css-tokenizer";
  const module = readFileSync(prefix + ".js", "utf8");
  expect(digest(module.split("\n").slice(3).join("\n"))).toBe(
    "e0bbb8e192f342676c371806a3cec73a6ca593f6d4fd7bd942a84d2eb7d4e374",
  );
  expect(digest(readFileSync(prefix + ".d.ts"))).toBe(
    "e330b2f5afe9c840ace7ff71fe48a15267cfc1d394df39f382b85dbffd2bfa68",
  );
  expect(digest(readFileSync("LICENSES/css-tokenizer-MIT.txt"))).toBe(
    "d00d032f517721b45c56c70c46bf904ebb71ad313df4d4db7722266b38069665",
  );
  expect(JSON.parse(readFileSync("package.json", "utf8")).dependencies["@csstools/css-tokenizer"]).toBeUndefined();
});

test("NJ preview CSS decodes escaped local resources through the upstream tokenizer", () => {
  const calls: [string, boolean][] = [];
  const output = rewritePreviewCss(
    '@import "theme.css"; .hero { background: u\\72l("im\\61ge.png") }',
    (url, sheet) => {
      calls.push([url, sheet]);
      return "/saved/" + url;
    },
  );
  expect(calls).toEqual([
    ["theme.css", true],
    ["image.png", false],
  ]);
  expect(output).toContain('"/saved/theme.css"');
  expect(output).toContain('url("/saved/image.png")');
});
