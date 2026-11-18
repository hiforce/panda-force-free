import { request } from "../http-client.js";
import { localizeText, setOpaqueText } from "../i18n.js";
import type { Translate } from "../../shared/i18n/messages.js";

/** Workspace-owned Blob URLs survive list/filter renders, but never survive leaving the owner's workspace. */
export class CreativeCovers {
  private root: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private readonly cache = new Map<string, { url: string; size: number }>();
  private readonly active = new Map<string, AbortController>();
  private readonly queue = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly nodes = new Set<HTMLImageElement>();
  private bytes = 0;
  constructor(private readonly t: Translate) {}
  render(root: HTMLElement) {
    for (const img of this.nodes) img.onload = img.onerror = null;
    this.nodes.clear();
    this.root = root;
    this.observer?.disconnect();
    const images = [...root.querySelectorAll<HTMLImageElement>("img[data-creative-cover]")],
      wanted = new Set(images.map((img) => img.dataset.creativeCover!));
    for (const [key, controller] of this.active) if (!wanted.has(key)) controller.abort();
    for (const key of this.queue) if (!wanted.has(key)) this.queue.delete(key);
    this.observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                if (entry.isIntersecting && root.contains(entry.target)) {
                  this.observer?.unobserve(entry.target);
                  const img = entry.target.querySelector<HTMLImageElement>("img[data-creative-cover]");
                  if (img) this.enqueue(img.dataset.creativeCover!);
                }
            },
            { rootMargin: "160px" },
          );
    for (const img of images) {
      this.nodes.add(img);
      const key = img.dataset.creativeCover!,
        cached = this.cache.get(key);
      img.onload = () => {
        img.hidden = false;
        const card = img.closest<HTMLElement>(".creative-card")!;
        card.dataset.coverState = "ready";
        card.querySelector<HTMLButtonElement>("[data-creative-cover-retry]")!.hidden = true;
        setOpaqueText(card.querySelector<HTMLElement>("[data-creative-cover-status]")!, "");
      };
      img.onerror = () => {
        this.drop(key);
        this.state(key, "failed");
      };
      const retry = img.closest(".creative-card")!.querySelector<HTMLButtonElement>("[data-creative-cover-retry]")!;
      retry.onclick = (event) => {
        event.stopPropagation();
        this.drop(key);
        this.failed.delete(key);
        this.enqueue(key);
      };
      if (cached) img.src = cached.url;
      else if (this.failed.has(key)) this.state(key, "failed");
      else if (this.active.has(key) && !this.active.get(key)!.signal.aborted) this.state(key, "loading");
      else if (this.observer) this.observer.observe(img.closest(".creative-asset-cover") ?? img.parentElement!);
      else this.enqueue(key);
    }
  }
  close() {
    for (const img of this.nodes) {
      img.onload = img.onerror = null;
      img.removeAttribute("src");
    }
    this.nodes.clear();
    this.root = null;
    this.observer?.disconnect();
    this.observer = null;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.queue.clear();
    this.failed.clear();
    for (const key of this.cache.keys()) this.drop(key);
  }
  private images(key: string) {
    return [...(this.root?.querySelectorAll<HTMLImageElement>("img[data-creative-cover]") ?? [])].filter(
      (img) => img.dataset.creativeCover === key,
    );
  }
  private state(key: string, state: "loading" | "failed") {
    if (state === "failed") {
      if (this.failed.size >= 64) this.failed.delete(this.failed.values().next().value!);
      this.failed.add(key);
    }
    for (const img of this.images(key)) {
      const card = img.closest<HTMLElement>(".creative-card")!;
      card.dataset.coverState = state;
      img.hidden = true;
      card.querySelector<HTMLButtonElement>("[data-creative-cover-retry]")!.hidden = state !== "failed";
      localizeText(
        card.querySelector<HTMLElement>("[data-creative-cover-status]")!,
        state === "failed" ? "creative.assetCoverFailed" : "creative.assetCoverLoading",
        {},
        this.t,
      );
    }
  }
  private enqueue(key: string) {
    if (this.failed.has(key) || this.cache.has(key) || (this.active.has(key) && !this.active.get(key)!.signal.aborted))
      return;
    this.queue.add(key);
    this.pump();
  }
  private pump() {
    while (this.active.size < 2 && this.queue.size) {
      const key = [...this.queue].find((value) => !this.active.has(value));
      if (!key) break;
      this.queue.delete(key);
      if (!this.root || !this.images(key).length) continue;
      const controller = new AbortController();
      this.active.set(key, controller);
      this.state(key, "loading");
      void this.load(key, controller);
    }
  }
  private async load(key: string, controller: AbortController) {
    try {
      const response = await request(key, {
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      });
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";")[0] !== "image/webp" ||
        Number(response.headers.get("content-length")) > 512 * 1024
      ) {
        await response.body?.cancel();
        throw new Error("Thumbnail unavailable");
      }
      const blob = await response.blob();
      if (controller.signal.aborted || this.active.get(key) !== controller || !this.root) return;
      if (!blob.size || blob.size > 512 * 1024) throw new Error("Invalid thumbnail");
      while (this.cache.size && (this.cache.size >= 32 || this.bytes + blob.size > 8 * 1024 * 1024))
        this.drop(this.cache.keys().next().value!);
      const url = URL.createObjectURL(blob);
      this.cache.set(key, { url, size: blob.size });
      this.bytes += blob.size;
      for (const img of this.images(key)) img.src = url;
    } catch {
      if (!controller.signal.aborted && this.active.get(key) === controller) this.state(key, "failed");
    } finally {
      if (this.active.get(key) === controller) this.active.delete(key);
      this.pump();
    }
  }
  private drop(key: string) {
    const value = this.cache.get(key);
    if (!value) return;
    URL.revokeObjectURL(value.url);
    this.bytes -= value.size;
    this.cache.delete(key);
  }
}
