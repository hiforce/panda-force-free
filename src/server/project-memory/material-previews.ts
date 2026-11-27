import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { HarnessError } from "../../shared/harness/contracts.js";
import { creativeFileExtension } from "../../shared/creative/file-types.js";
import { renderDocumentMarkdown } from "../../shared/documents/render-markdown.js";
import {
  memoryMaterialCitationKind,
  memoryMaterialPreview,
  memoryMaterialPreviewTextBytes,
  type MemoryMaterialAnchor,
  type MemoryMaterialFile,
  type MemoryMaterialKind,
} from "../../shared/project-memory/materials.js";
import { CreativeSlidePreviews } from "../creative/assets/slide-previews.js";
import { preparePdfPreview, renderSlideDeck } from "../creative/assets/slide-renderer.js";
import { respondCreativeInline } from "../creative/assets/inline.js";
import type { RouteContext } from "../http/router.js";

export interface MemoryMaterialPreviewSource {
  identity: readonly string[];
  kind: MemoryMaterialKind;
  file: MemoryMaterialFile;
  read(): Promise<Uint8Array>;
  verify(): Promise<unknown>;
}

export function materialRequestSignal(context: RouteContext) {
  const disconnect = new AbortController();
  const cancel = () => {
    if (!context.res.writableEnded) disconnect.abort();
  };
  context.res.once("close", cancel);
  if (context.res.destroyed) cancel();
  return {
    signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(45000)]),
    release: () => context.res.removeListener("close", cancel),
  };
}
function paragraphs(text: string) {
  const pending: DefaultTreeAdapterMap["childNode"][] = [...parseFragment(renderDocumentMarkdown(text)).childNodes];
  let total = 0;
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index]!;
    if ("tagName" in node && node.tagName === "p") total++;
    if ("childNodes" in node) for (const child of node.childNodes) pending.push(child);
  }
  return total;
}

export class MemoryMaterialPreviews {
  private readonly pages = new CreativeSlidePreviews();

  private pageSource(source: MemoryMaterialPreviewSource, pdf: boolean) {
    const key = JSON.stringify([...source.identity, source.file.digest, pdf]);
    const convert = pdf ? preparePdfPreview : renderSlideDeck;
    return { key, load: async (signal: AbortSignal) => convert(await source.read(), signal) };
  }

  readPage(source: MemoryMaterialPreviewSource, page: number, kind: "page" | "slide", signal: AbortSignal) {
    const { key, load } = this.pageSource(source, kind === "page");
    return this.pages.readRevision(key, page, signal, source.verify, load);
  }

  async respond(context: RouteContext, source: MemoryMaterialPreviewSource, signal: AbortSignal) {
    const { file, kind } = source;
    if (file.size > 32 * 1024 * 1024) throw new HarnessError("contextTooLarge", 413);
    const preview = memoryMaterialPreview(kind, file.name);
    if (preview.kind === "download") throw new HarnessError("notFound", 404);
    if (preview.kind === "slides" || preview.kind === "pdf") {
      const page = context.url.searchParams.get("page") ?? "1";
      if (!/^[1-9][0-9]{0,2}$/u.test(page)) throw new HarnessError("invalidInput");
      const rendered = await this.readPage(source, Number(page), preview.kind === "pdf" ? "page" : "slide", signal);
      context.res.setHeader("x-panda-slide-count", rendered.pages);
      respondCreativeInline(context, rendered.bytes, "image/png", "page-" + page + ".png", file.digest + "-" + page);
      return;
    }
    const bytes = await source.read();
    signal.throwIfAborted();
    await source.verify();
    respondCreativeInline(context, bytes, preview.mime, file.name, file.digest);
  }

  async validate(source: MemoryMaterialPreviewSource, anchors: readonly MemoryMaterialAnchor[], signal: AbortSignal) {
    signal.throwIfAborted();
    const { file, kind } = source;
    const format = memoryMaterialCitationKind(kind, file.name);
    if (!format || anchors.some(({ location }) => location.kind !== format)) throw new HarnessError("invalidInput");
    if (file.size > 32 * 1024 * 1024) throw new HarnessError("contextTooLarge", 413);
    if (format !== "image") {
      let count: number;
      if (format === "slide" || format === "page") {
        const { key, load } = this.pageSource(source, format === "page");
        count = await this.pages.countRevision(key, signal, load);
      } else {
        const bytes = (await source.read()).subarray(0, memoryMaterialPreviewTextBytes);
        const text = new TextDecoder().decode(bytes);
        count =
          kind === "document" || creativeFileExtension(file.name) === "md" ? paragraphs(text) : Number(!!text.trim());
      }
      if (anchors.some(({ location }) => location.kind !== "image" && location.number > count))
        throw new HarnessError("invalidInput");
    }
    await source.verify();
  }
}
