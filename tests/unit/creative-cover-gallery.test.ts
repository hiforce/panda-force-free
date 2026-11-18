import { beforeEach, afterEach, expect, test, mock } from "bun:test";
import { JSDOM } from "jsdom";
import { CreativeCovers } from "../../src/client/creative/covers.js";
import { serverTranslator } from "../../src/server/i18n/messages.js";
import { creativeCards } from "../../src/client/creative/cards.js";
import type { CreativeAsset } from "../../src/shared/creative/assets.js";
let dom: JSDOM, visible: ((elements: Element[]) => void)[], observed: Element[];
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  dom = new JSDOM('<html lang="en"><body><main></main></body></html>', { url: "https://app.example.test" });
  visible = [];
  observed = [];
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      visible.push((elements) =>
        callback(
          elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
          this as unknown as IntersectionObserver,
        ),
      );
    }
    observe(element: Element) {
      observed.push(element);
    }
    unobserve() {}
    disconnect() {}
  }
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IntersectionObserver: Observer,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
afterEach(() => {
  mock.restore();
  for (const [name, value] of previous) {
    if (value) Object.defineProperty(globalThis, name, value);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.window.close();
});
function render(root: HTMLElement, keys: string[]) {
  root.innerHTML = keys
    .map(
      (key) =>
        `<article class="creative-card"><div class="creative-asset-cover"><img data-creative-cover="/api/creative-assets/view?id=${key}&variant=cover" hidden><span data-creative-cover-status></span></div><button data-creative-cover-retry hidden></button></article>`,
    )
    .join("");
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 15));
test("real gallery markup supports image, trash and purge actions without invalid icons or nested buttons", () => {
  const asset: CreativeAsset = {
    schema: 1,
    id: "image",
    project: "personal",
    kind: "image",
    title: "An image",
    locale: "en",
    version: "a".repeat(64),
    previousVersion: null,
    state: "saved",
    source: { name: "image.png", digest: "b".repeat(64), size: 4096 },
    resources: [],
    createdAt: 1,
    updatedAt: 1,
  };
  for (const state of ["saved", "trashed", "purging"] as const) {
    const fragment = JSDOM.fragment(
      creativeCards(serverTranslator("en"), [{ kind: "asset", value: { ...asset, state } }], true),
    );
    expect(fragment.querySelector("button button")).toBeNull();
    expect(fragment.querySelector("img[data-creative-cover]") !== null).toBe(state === "saved");
    expect(fragment.querySelector("[data-creative-cover-retry]") !== null).toBe(state === "saved");
  }
});
test("only visible covers load and completed Blob URLs are reused across filter and locale renders", async () => {
  const root = document.querySelector<HTMLElement>("main")!,
    covers = new CreativeCovers(serverTranslator("en")),
    original = globalThis.fetch;
  const fetcher = mock(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/webp" } }));
  globalThis.fetch = Object.assign(fetcher, { preconnect: original.preconnect });
  try {
    render(root, ["one", "two"]);
    covers.render(root);
    expect(fetcher).not.toHaveBeenCalled();
    expect(observed.length).toBe(2);
    expect(
      observed.every((element) => element.matches(".creative-asset-cover") && !element.hasAttribute("hidden")),
    ).toBe(true);
    visible[0]!([root.querySelector(".creative-asset-cover")!]);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = root.querySelector<HTMLImageElement>("img")!.src;
    expect(url).toStartWith("blob:");
    render(root, ["one"]);
    covers.render(root);
    expect(root.querySelector<HTMLImageElement>("img")!.src).toBe(url);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    covers.close();
    globalThis.fetch = original;
  }
});
test("cover IO is capped at two and leaving aborts pending jobs without accepting late private bytes", async () => {
  const root = document.querySelector<HTMLElement>("main")!,
    covers = new CreativeCovers(serverTranslator("en")),
    original = globalThis.fetch;
  const signals: AbortSignal[] = [],
    resolves: ((value: Response) => void)[] = [];
  const fetcher = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!);
    return new Promise<Response>((resolve) => resolves.push(resolve));
  });
  globalThis.fetch = Object.assign(fetcher, { preconnect: original.preconnect });
  try {
    render(root, ["one", "two", "three"]);
    covers.render(root);
    visible[0]!([...root.querySelectorAll(".creative-asset-cover")]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    covers.close();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const resolve of resolves)
      resolve(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/webp" } }));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect([...root.querySelectorAll("img")].every((img) => !img.getAttribute("src"))).toBe(true);
  } finally {
    covers.close();
    globalThis.fetch = original;
  }
});
test("a failed cover can retry without activating the original-file action", async () => {
  const root = document.querySelector<HTMLElement>("main")!,
    covers = new CreativeCovers(serverTranslator("en")),
    original = globalThis.fetch;
  const fetcher = mock(async () =>
    fetcher.mock.calls.length === 1
      ? new Response("Unavailable", { status: 503 })
      : new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/webp" } }),
  );
  globalThis.fetch = Object.assign(fetcher, { preconnect: original.preconnect });
  const clicked = mock(() => {});
  root.onclick = clicked;
  try {
    render(root, ["one"]);
    covers.render(root);
    visible[0]!([root.querySelector(".creative-asset-cover")!]);
    await flush();
    expect(root.querySelector<HTMLButtonElement>("button")!.hidden).toBe(false);
    render(root, ["one"]);
    covers.render(root);
    visible[1]!([root.querySelector(".creative-asset-cover")!]);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(root.querySelector<HTMLButtonElement>("button")!.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>("button")!.click();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(clicked).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLImageElement>("img")!.src).toStartWith("blob:");
  } finally {
    covers.close();
    globalThis.fetch = original;
  }
});
