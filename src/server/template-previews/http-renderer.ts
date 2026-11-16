import { readFile } from "node:fs/promises";
import type { TemplatePreviewRenderer } from "./ports.js";
import type { TemplatePreviewRaster } from "../../shared/template-previews/contracts.js";
import { TemplatePreviewError } from "./errors.js";
export class HttpTemplatePreviewRenderer implements TemplatePreviewRenderer {
  private readonly endpoint: string;
  constructor(
    url: string,
    private readonly tokenFile: string,
  ) {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      throw new TemplatePreviewError("invalidInput");
    this.endpoint = parsed.origin + "/v1/render";
  }
  async render(input: Parameters<TemplatePreviewRenderer["render"]>[0], signal: AbortSignal) {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new TemplatePreviewError("unavailable");
    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TemplatePreviewError("unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TemplatePreviewError("unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 25 * 1024 * 1024) throw new TemplatePreviewError("unavailable");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as TemplatePreviewRaster;
  }
}
