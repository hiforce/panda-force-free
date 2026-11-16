import { expect, test } from "bun:test";
import sharp from "sharp";
import { renderTemplatePreview } from "../../src/preview-renderer/render.js";
import { TEMPLATE_PREVIEW_RENDERER, type TemplatePreviewInput } from "../../src/shared/template-previews/contracts.js";
test("fixed static raster viewports never execute supplied JavaScript or request external resources", async () => {
  let calls = 0;
  const trap = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response("private");
    },
  });
  try {
    const url = `http://127.0.0.1:${trap.port}/never`,
      html = `<style>body{background:#eee9e2}h1{font-size:48px}</style><h1>Public preview</h1><img src="${url}"><script>fetch('${url}')</script><iframe src="${url}"></iframe>`;
    const result = await renderTemplatePreview({
      schema: 1,
      renderer: TEMPLATE_PREVIEW_RENDERER,
      locale: "en",
      home: html,
      article: html,
    });
    expect(calls).toBe(0);
    expect(result.renderer).toBe(TEMPLATE_PREVIEW_RENDERER);
    for (const [view, image] of Object.entries(result.images)) {
      const metadata = await sharp(Buffer.from(image.png, "base64")).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.width).toBe(view === "mobile" ? 390 : 1440);
      expect(metadata.height).toBe(view === "mobile" ? 844 : 960);
    }
    await expect(
      renderTemplatePreview({
        schema: 1,
        renderer: TEMPLATE_PREVIEW_RENDERER,
        locale: "en",
        home: html,
        article: html,
        url,
      } as TemplatePreviewInput),
    ).rejects.toThrow("invalidPreview");
  } finally {
    await trap.stop(true);
  }
}, 30000);
