import type { CreativeAsset } from "../../shared/creative/assets.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { localizeAttribute, localizeText, messageAttributes, messageHtml } from "../i18n.js";
import { request } from "../http-client.js";
import { creativeAssetsApi } from "./assets-api.js";

export function slidePreviewView(t: Translate, text: string, pdf = false, jump = false) {
  const turn = (direction: "previous" | "next") => {
    const label = pdf
      ? direction === "previous"
        ? "projects.memoryMaterialPreviousPage"
        : "projects.memoryMaterialNextPage"
      : direction === "previous"
        ? "creative.assetPreviousSlide"
        : "creative.assetNextSlide";
    return `<button type="button" class="wb-button creative-slide-turn" data-slide-${direction} ${messageAttributes("aria-label", label, {}, t)} ${messageAttributes("title", label, {}, t)}>${codexIcon(direction === "previous" ? "chevronLeft" : "chevronRight")}</button>`;
  };
  const numberLabel = pdf ? "projects.memoryCitationPageNumber" : "projects.memoryCitationSlideNumber";
  const position = `<span role="status" data-slide-position${jump ? ' class="sr-only"' : ""}></span>`;
  const navigator = jump
    ? `<div class="creative-slide-jump">${position}<input type="number" min="1" inputmode="numeric" data-slide-jump
      ${messageAttributes("aria-label", numberLabel, {}, t)}><span data-slide-total aria-hidden="true"></span></div>`
    : position;
  return `<section class="creative-slide-reader" data-slide-reader>
    <div class="creative-slide-stage" data-slide-stage aria-busy="true"><img class="creative-slide-image" data-slide-image alt="" role="img" hidden><p role="status" data-slide-status>${messageHtml(pdf ? "projects.memoryMaterialRenderingPage" : "creative.assetRenderingSlides", {}, t)}</p><button type="button" class="wb-button" data-slide-retry hidden>${messageHtml("common.retry", {}, t)}</button></div>
    <div class="creative-slide-pages" data-slide-pages hidden>${turn("previous")}${navigator}${turn("next")}</div>
    ${text ? `<details class="creative-slide-text" data-slide-text><summary>${messageHtml("creative.assetReadableText", {}, t)}</summary>${text}</details>` : ""}
    </section>`;
}

export function bindSlidePreview(body: HTMLElement, asset: CreativeAsset, t: Translate, signal: AbortSignal) {
  bindPagedPreview(body, (index) => creativeAssetsApi.slidePreview(asset, index), t, signal);
}

export function bindPagedPreview(
  body: HTMLElement,
  pageUrl: (index: number) => string,
  t: Translate,
  signal: AbortSignal,
  options: {
    initial?: number;
    pdf?: boolean;
    unavailable?: string;
    notFound?: string;
    onPage?: (index: number | null) => void;
  } = {},
) {
  const root = body.querySelector("[data-slide-reader]");
  if (!root) return;
  const stage = root.querySelector<HTMLElement>("[data-slide-stage]")!,
    image = root.querySelector<HTMLImageElement>("[data-slide-image]")!,
    status = root.querySelector<HTMLElement>("[data-slide-status]")!,
    retry = root.querySelector<HTMLButtonElement>("[data-slide-retry]")!,
    controls = root.querySelector<HTMLElement>("[data-slide-pages]")!,
    position = root.querySelector<HTMLElement>("[data-slide-position]")!,
    jump = root.querySelector<HTMLInputElement>("[data-slide-jump]"),
    pageTotal = root.querySelector<HTMLElement>("[data-slide-total]"),
    previous = root.querySelector<HTMLButtonElement>("[data-slide-previous]")!,
    next = root.querySelector<HTMLButtonElement>("[data-slide-next]")!,
    text = root.querySelector<HTMLDetailsElement>("[data-slide-text]");
  let page = 0,
    total = 0,
    requested = options.initial ?? 1,
    loading = false,
    shown = "",
    incoming = "";
  signal.addEventListener(
    "abort",
    () => {
      URL.revokeObjectURL(shown);
      URL.revokeObjectURL(incoming);
    },
    { once: true },
  );
  function buttons() {
    controls.hidden = total < 2;
    previous.disabled = loading || page <= 1;
    next.disabled = loading || page >= total;
    if (jump) {
      jump.disabled = loading;
      jump.value = page ? String(page) : "";
      jump.max = String(total);
    }
  }
  async function load(index: number) {
    if (loading || signal.aborted || index < 1 || (total && index > total)) return;
    requested = index;
    loading = true;
    options.onPage?.(null);
    buttons();
    stage.setAttribute("aria-busy", "true");
    retry.hidden = true;
    status.hidden = false;
    localizeText(status, options.pdf ? "projects.memoryMaterialRenderingPage" : "creative.assetRenderingSlides", {}, t);
    let failure = options.unavailable;
    try {
      const response = await request(pageUrl(index), { signal });
      if (response.status === 404 && options.notFound) failure = options.notFound;
      const count = Number(response.headers.get("x-panda-slide-count"));
      if (
        !response.ok ||
        response.headers.get("content-type") !== "image/png" ||
        !Number.isInteger(count) ||
        count < index ||
        count > 500
      ) {
        await response.body?.cancel();
        throw new Error("Slide preview failed");
      }
      const blob = await response.blob();
      if (signal.aborted) return;
      incoming = URL.createObjectURL(blob);
      const decoded = new Image();
      decoded.src = incoming;
      await decoded.decode();
      if (signal.aborted) return;
      image.src = incoming;
      URL.revokeObjectURL(shown);
      shown = incoming;
      incoming = "";
      image.hidden = false;
      status.hidden = true;
      if (options.pdf) localizeAttribute(image, "aria-label", "projects.memoryMaterialPage", { number: index }, t);
      else localizeAttribute(image, "aria-label", "creative.assetSlide", { index }, t);
      page = index;
      total = count;
      localizeText(position, "creative.assetSlidePosition", { index, total }, t);
      if (pageTotal) pageTotal.textContent = "/ " + new Intl.NumberFormat(document.documentElement.lang).format(total);
      options.onPage?.(page);
    } catch {
      if (signal.aborted) return;
      URL.revokeObjectURL(incoming);
      incoming = "";
      if (failure) status.textContent = failure;
      else localizeText(status, "creative.assetSlideRenderFailed", {}, t);
      retry.hidden = false;
      if (!page && text) text.open = true;
    } finally {
      loading = false;
      if (!signal.aborted) {
        stage.setAttribute("aria-busy", "false");
        buttons();
      }
    }
  }
  previous.addEventListener("click", () => void load(page - 1), { signal });
  next.addEventListener("click", () => void load(page + 1), { signal });
  retry.addEventListener("click", () => void load(requested), { signal });
  if (jump) {
    const choose = () => {
      const index = jump.valueAsNumber;
      if (jump.checkValidity() && Number.isSafeInteger(index) && index !== page) void load(index);
      else buttons();
    };
    jump.addEventListener("change", choose, { signal });
    jump.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          choose();
        }
      },
      { signal },
    );
  }
  void load(requested);
}
