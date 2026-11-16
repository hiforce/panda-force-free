import { chromium, type Browser } from "playwright";
import { isSupportedLocale } from "../shared/i18n/locale-policy.js";
import {
  TEMPLATE_PREVIEW_RENDERER,
  TEMPLATE_PREVIEW_VIEWS,
  type TemplatePreviewInput,
  type TemplatePreviewRaster,
} from "../shared/template-previews/contracts.js";

/** Only supplied static documents are rendered. No URL, script, account, project filesystem or network authority is accepted. */
export async function renderTemplatePreview(input: TemplatePreviewInput): Promise<TemplatePreviewRaster> {
  if (
    input.schema !== 1 ||
    input.renderer !== TEMPLATE_PREVIEW_RENDERER ||
    !isSupportedLocale(input.locale) ||
    Object.keys(input).sort().join(",") !== "article,home,locale,renderer,schema" ||
    typeof input.home !== "string" ||
    typeof input.article !== "string" ||
    Buffer.byteLength(input.home) + Buffer.byteLength(input.article) > 40 * 1024 * 1024
  )
    throw new Error("invalidPreview");
  let browser: Browser | undefined;
  const timer = setTimeout(() => void browser?.close(), 45000);
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 10000,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const images = {} as TemplatePreviewRaster["images"];
    for (const view of TEMPLATE_PREVIEW_VIEWS) {
      const viewport = view === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 960 };
      const context = await browser.newContext({
        viewport,
        locale: input.locale,
        javaScriptEnabled: false,
        serviceWorkers: "block",
        offline: true,
      });
      await context.route("**/*", (route) => route.abort());
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await page.setContent(
          "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'\">" +
            (view === "home" ? input.home : input.article),
          { waitUntil: "load", timeout: 10000 },
        );
        const png = await page.screenshot({ type: "png", animations: "disabled", timeout: 10000 });
        if (png.length > 6 * 1024 * 1024) throw new Error("previewTooLarge");
        images[view] = { png: png.toString("base64"), ...viewport };
      } finally {
        await context.close();
      }
    }
    return { schema: 1, renderer: TEMPLATE_PREVIEW_RENDERER, images };
  } finally {
    clearTimeout(timer);
    await browser?.close();
  }
}
