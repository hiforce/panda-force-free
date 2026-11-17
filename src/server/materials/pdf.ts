import { getDocumentProxy } from "./vendor/pdf-parser.mjs";
import { MATERIAL_TEXT_LIMITS as limits, MaterialTextError, type MaterialText } from "./contracts.js";
import { MaterialTextBuilder } from "./builder.js";
/** Source bytes only: no URL, font directory, evaluation, external resource or renderer is enabled. */
export async function pdfMaterialText(bytes: Uint8Array): Promise<MaterialText> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      verbosity: 0,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      standardFontDataUrl: undefined,
      cMapUrl: undefined,
      wasmUrl: undefined,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: true,
    });
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new MaterialTextError("unreadable");
    if (pdf.numPages > limits.pages) throw new MaterialTextError("tooLarge");
    const builder = new MaterialTextBuilder();
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      try {
        const content = await page.getTextContent(),
          parts: string[] = [];
        let bytes = 0;
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          bytes += Buffer.byteLength(item.str) + 1;
          if (bytes > limits.textBytes) throw new MaterialTextError("tooLarge");
          parts.push(item.str, item.hasEOL ? "\n" : " ");
        }
        builder.add(parts.join("").trimEnd());
      } finally {
        page.cleanup();
      }
    }
    return builder.result();
  } catch (error) {
    if (error instanceof MaterialTextError) throw error;
    throw new MaterialTextError(
      error instanceof Error && error.name === "PasswordException" ? "encrypted" : "unreadable",
    );
  } finally {
    await pdf?.loadingTask.destroy();
  }
}
