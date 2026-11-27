import { DocumentError } from "../../documents/errors.js";
import type { CreativeAsset } from "../../../shared/creative/assets.js";
import type { FileCreativeAssetReader } from "./reader.js";
import { rasterSlide, renderSlideDeck, type RenderedSlideDeck } from "./slide-renderer.js";

interface Preparation {
  abort: AbortController;
  ready: Promise<RenderedSlideDeck>;
  waiting: number;
}

/** Derivatives stay in memory. Authorize and verify the same source version before and after rendering. */
export class CreativeSlidePreviews {
  private readonly decks = new Map<string, { deck: RenderedSlideDeck; expires: number }>();
  private readonly preparing = new Map<string, Preparation>();
  private bytes = 0;
  private active = 0;

  async read(
    owner: string,
    service: Pick<FileCreativeAssetReader, "resource">,
    project: string,
    id: string,
    version: string,
    page: number,
    signal: AbortSignal,
  ) {
    const slideOnly = (asset: CreativeAsset) => {
      if (asset.kind !== "slides") throw new DocumentError("invalidInput");
    };
    const current = () =>
      service.resource(project, id, {
        version,
        signal,
        select: (asset) => {
          slideOnly(asset);
          return { head: true };
        },
      });
    const source = await current(),
      key = JSON.stringify([owner, project, id, version, source.resource.digest]);
    return this.readRevision(key, page, signal, current, async (preparing) => {
      const original = await service.resource(project, id, {
        version,
        signal: preparing,
        select: (asset) => {
          slideOnly(asset);
          return {};
        },
      });
      return renderSlideDeck(original.bytes!, preparing);
    });
  }

  /** Scope cached renders by source identity and recheck access before sending each page. */
  async readRevision(
    key: string,
    page: number,
    signal: AbortSignal,
    authorize: () => Promise<unknown>,
    prepare: (signal: AbortSignal) => Promise<RenderedSlideDeck>,
  ) {
    const deck = await this.deck(key, signal, prepare);
    if (page > deck.pages) throw new DocumentError("notFound", 404);
    const bytes = await rasterSlide(deck, page, signal);
    await authorize();
    return { bytes, pages: deck.pages };
  }

  async countRevision(key: string, signal: AbortSignal, prepare: (signal: AbortSignal) => Promise<RenderedSlideDeck>) {
    return (await this.deck(key, signal, prepare)).pages;
  }

  private async deck(key: string, signal: AbortSignal, prepare: (signal: AbortSignal) => Promise<RenderedSlideDeck>) {
    signal.throwIfAborted();
    const cached = this.decks.get(key);
    if (cached) {
      this.decks.delete(key);
      if (cached.expires > Date.now()) {
        this.decks.set(key, cached);
        return cached.deck;
      }
      this.bytes -= cached.deck.pdf.length;
    }
    let job = this.preparing.get(key);
    if (!job || job.abort.signal.aborted) {
      if (this.active >= 2) throw new DocumentError("busy", 429);
      const abort = new AbortController();
      this.active++;
      const ready = prepare(abort.signal)
        .then((deck) => {
          abort.signal.throwIfAborted();
          while (this.decks.size && (this.decks.size >= 6 || this.bytes + deck.pdf.length > 48 * 1024 * 1024)) {
            const oldest = this.decks.keys().next().value!;
            this.bytes -= this.decks.get(oldest)!.deck.pdf.length;
            this.decks.delete(oldest);
          }
          this.decks.set(key, { deck, expires: Date.now() + 300_000 });
          this.bytes += deck.pdf.length;
          return deck;
        })
        .finally(() => {
          this.active--;
          if (this.preparing.get(key)?.ready === ready) this.preparing.delete(key);
        });
      job = { ready, abort, waiting: 0 };
      this.preparing.set(key, job);
    }
    job.waiting++;
    let cancel = () => {};
    try {
      return await Promise.race([
        job.ready,
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new DocumentError("unavailable", 503));
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!--job.waiting) job.abort.abort();
    }
  }
}
