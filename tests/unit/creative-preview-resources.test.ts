import { expect, test } from "bun:test";
import { parse } from "parse5";
import { staticCreativePreview } from "../../src/server/creative/assets/preview.js";
import { rewritePreviewCss } from "../../src/server/creative/assets/preview-css.js";

test("preview CSS uses decoded URL tokens and import context without rewriting ordinary string content", () => {
  const seen: [string, boolean][] = [],
    result = rewritePreviewCss(
      '@import "base.css" screen; .hero{background:u\\72l(../images/a.png)} .logo{background:URL( "logo.png" /* note */ )} .text{content:"url(unchanged.png)"}',
      (value, sheet) => {
        seen.push([value, sheet]);
        return "data:,retained";
      },
    );
  expect(seen).toEqual([
    ["base.css", true],
    ["../images/a.png", false],
    ["logo.png", false],
  ]);
  expect(result).toContain('content:"url(unchanged.png)"');
  expect(result).not.toContain("logo.png");
});

test("responsive image-set URLs retain media type strings and ordinary text", () => {
  const seen: string[] = [],
    result = rewritePreviewCss(
      '.hero{background:image-set("hero.avif" type("image/avif") 1x, url("hero.png") 2x)} .text{content:"hero.png"}',
      (value) => {
        seen.push(value);
        return "data:,local";
      },
    );
  expect(seen).toEqual(["hero.avif", "hero.png"]);
  expect(result).toContain('type("image/avif")');
  expect(result).toContain('content:"hero.png"');
});

test("static bundle previews resolve nested CSS, fonts and images from owned bytes without network or raw-text injection", () => {
  const files = [
      {
        name: "site/css/main.css",
        bytes: Buffer.from(
          '@import "colors.css"; @font-face{font-family:Local;src:url(../fonts/local.woff2)} .hero{background:url(../images/hero.png)} .remote{background:url(https://external.invalid/a)} .text:after{content:"</style><img src=https://external.invalid/injected>"}',
        ),
      },
      { name: "site/css/colors.css", bytes: Buffer.from('@import "main.css";h1{color:rgb(12, 34, 56)}') },
      { name: "site/images/hero.png", bytes: Buffer.from([0, 1, 2, 255]) },
      { name: "site/fonts/local.woff2", bytes: Buffer.from([1, 2, 3]) },
    ],
    html = Buffer.from(
      '<html><head><link rel="stylesheet" href="css/main.css"></head><body><h1>Owned preview</h1><img src="images/hero.png?v=1"><div style="background:url(images/hero.png)">Retained</div><img src="https://external.invalid/direct"><script>neverExecute()</script></body></html>',
    ),
    result = staticCreativePreview(html, "site/index.html", files)!;
  expect(result).toContain("Owned preview");
  expect(result).toContain("data:text/css;charset=utf-8;base64,");
  expect(result).toContain("data:image/png;base64,");
  expect(result).toContain("data:font/woff2;base64,");
  expect(result).toContain("font-src data:");
  expect(result).not.toContain("<script");
  expect(result).not.toContain("<link");
  expect(result).not.toContain("neverExecute");
  expect(result).not.toContain("external.invalid/direct");
  const document = parse(result),
    images: unknown[] = [];
  const visit = (node: typeof document | Record<string, unknown>) => {
    if ("tagName" in node && node.tagName === "img") images.push(node);
    if ("childNodes" in node && Array.isArray(node.childNodes)) for (const child of node.childNodes) visit(child);
  };
  visit(document);
  expect(images).toHaveLength(2);
  expect(result).toContain("\\3c /style>");
});
