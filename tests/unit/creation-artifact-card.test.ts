import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { CreationArtifact, CreationTaskView } from "../../src/shared/creation/contracts.js";
import { CreationCards } from "../../src/client/creation/cards.js";
import { serverTranslator } from "../../src/server/i18n/messages.js";

let dom: JSDOM;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let visible: (() => void)[] = [];
beforeEach(() => {
  dom = new JSDOM('<html lang="en"><body><main></main></body></html>', { url: "https://app.example.test" });
  visible = [];
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      visible.push(() =>
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
      );
    }
    observe() {}
    disconnect() {}
  }
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IntersectionObserver: Observer,
  })) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
afterEach(() => {
  mock.restore();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.window.close();
});
const artifact: Exclude<CreationArtifact, { kind: "document" }> = {
  kind: "image",
  projectId: "personal",
  assetId: "saved-image",
  operationId: "saved-operation",
  version: "a".repeat(64),
  commit: "b".repeat(40),
  title: "Computer history <script>unsafe()</script>",
  source: { name: "computer-history.png", size: 22123, digest: "c".repeat(64) },
};
const task = (saved: CreationArtifact | null): CreationTaskView => ({
  id: "task",
  projectId: "personal",
  state: saved ? "succeeded" : "running",
  generation: 1,
  prompt: "Create computer history",
  model: null,
  cancelRequested: false,
  artifact: saved,
  failure: null,
  question: null,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture() {
  const host = document.querySelector<HTMLElement>("main")!,
    open = mock(() => {});
  const cards = new CreationCards(
    host,
    serverTranslator("en"),
    () => {},
    open,
    () => {},
    undefined,
    { brief: false, openAction: false },
  );
  return { host, open, cards };
}
test("saved receipts appear without metadata IO and polling preserves the preview and direct actions", async () => {
  const fetcher = mock(
    async () =>
      new Response(new Uint8Array([1, 2]), {
        headers: {
          "content-type": "image/webp",
          "x-panda-image-width": "1122",
          "x-panda-image-height": "1402",
        },
      }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  const { host, open, cards } = fixture();
  try {
    cards.render([task(null)]);
    expect(host.querySelector(".creation-artifact")).toBeNull();
    cards.render([task(artifact)]);
    expect(host.textContent).toContain(artifact.title);
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("computer-history.png");
    expect(fetcher).not.toHaveBeenCalled();
    const button = host.querySelector<HTMLButtonElement>(".creation-artifact-preview")!;
    button.click();
    expect(open).toHaveBeenCalledWith(artifact);
    const download = new URL(host.querySelector<HTMLAnchorElement>("a[download]")!.href);
    expect(download.pathname).toBe("/api/creative-assets/content");
    expect(download.searchParams.get("version")).toBe(artifact.version);
    visible[0]!();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("1122 × 1402 pixels");
    const img = host.querySelector<HTMLImageElement>("img")!;
    img.dispatchEvent(new dom.window.Event("load"));
    expect(img.hidden).toBe(false);
    expect(img.src).toStartWith("blob:");
    cards.render([task(artifact)]);
    expect(host.querySelector("img")).toBe(img);
    expect(fetcher).toHaveBeenCalledTimes(1);
    cards.render([]);
    expect(img.getAttribute("src")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
  } finally {
    cards.dispose();
    globalThis.fetch = original;
  }
});
test("cover failure retries only the cover and leaving aborts a late response", async () => {
  let signal: AbortSignal | null = null;
  const fetcher = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? null;
    if (fetcher.mock.calls.length === 1) return new Response("Unavailable", { status: 503 });
    return await new Promise<Response>((resolve) =>
      setTimeout(() => resolve(new Response("Late", { headers: { "content-type": "image/webp" } })), 40),
    );
  });
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  const { host, cards } = fixture();
  try {
    cards.render([task(artifact)]);
    visible[0]!();
    await flush();
    expect(host.querySelector<HTMLElement>(".creation-artifact-error")!.hidden).toBe(false);
    host.querySelector<HTMLButtonElement>("[data-artifact-retry]")!.click();
    expect(fetcher).toHaveBeenCalledTimes(2);
    cards.dispose();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.querySelector("img")!.getAttribute("src")).toBeNull();
  } finally {
    cards.dispose();
    globalThis.fetch = original;
  }
});
test("all creation formats retain titles and direct entry points in each locale", () => {
  for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"] as const) {
    document.documentElement.lang = locale;
    for (const kind of ["document", "slides", "web"] as const) {
      const host = document.querySelector<HTMLElement>("main")!;
      const cards = new CreationCards(
        host,
        serverTranslator(locale),
        () => {},
        () => {},
        () => {},
        undefined,
        { openAction: false },
      );
      cards.render([
        task(
          kind === "document"
            ? {
                kind,
                projectId: "personal",
                documentId: "doc",
                operationId: "op",
                treeVersion: 1,
                title: "Requirements",
                file: { path: "docs/requirements.md", format: "markdown" },
              }
            : {
                ...artifact,
                kind,
                source: { ...artifact.source, name: kind === "slides" ? "history.pptx" : "history.html" },
              },
        ),
      ]);
      expect(host.querySelectorAll('[data-creation-action="open"]')).toHaveLength(1);
      expect(host.textContent).not.toContain("creation.");
      expect(host.querySelector("a[download]") !== null).toBe(kind !== "document");
      cards.dispose();
      host.replaceChildren();
    }
  }
});
