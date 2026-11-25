import type { CreativeAsset } from "../../shared/creative/assets.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { localizeAttribute, localizeText, messageAttributes, messageHtml } from "../i18n.js";
import { request } from "../http-client.js";
import { creativeAssetsApi } from "./assets-api.js";

export function slidePreviewView(t: Translate, text: string) {
  const turn = (direction: "previous" | "next") => {
    const label = direction === "previous" ? "creative.assetPreviousSlide" : "creative.assetNextSlide";
    return `<button type="button" class="wb-button creative-slide-turn" data-slide-${direction} ${messageAttributes("aria-label", label, {}, t)} ${messageAttributes("title", label, {}, t)}>${codexIcon(direction === "previous" ? "chevronLeft" : "chevronRight")}</button>`;
  };
  return `<section class="creative-slide-reader" data-slide-reader>
    <div class="creative-slide-stage" data-slide-stage aria-busy="true"><img class="creative-slide-image" data-slide-image alt="" role="img" hidden><p role="status" data-slide-status>${messageHtml("creative.assetRenderingSlides", {}, t)}</p><button type="button" class="wb-button" data-slide-retry hidden>${messageHtml("common.retry", {}, t)}</button></div>
    <div class="creative-slide-pages" data-slide-pages hidden>${turn("previous")}<span role="status" data-slide-position></span>${turn("next")}</div>
    <details class="creative-slide-text" data-slide-text><summary>${messageHtml("creative.assetReadableText", {}, t)}</summary>${text}</details>
    </section>`;
}

export function bindSlidePreview(body: HTMLElement, asset: CreativeAsset, t: Translate, signal: AbortSignal) {
  const root = body.querySelector("[data-slide-reader]");
  if (!root) return;
  const stage = root.querySelector<HTMLElement>("[data-slide-stage]")!,
    image = root.querySelector<HTMLImageElement>("[data-slide-image]")!,
    status = root.querySelector<HTMLElement>("[data-slide-status]")!,
    retry = root.querySelector<HTMLButtonElement>("[data-slide-retry]")!,
    controls = root.querySelector<HTMLElement>("[data-slide-pages]")!,
    position = root.querySelector<HTMLElement>("[data-slide-position]")!,
    previous = root.querySelector<HTMLButtonElement>("[data-slide-previous]")!,
    next = root.querySelector<HTMLButtonElement>("[data-slide-next]")!,
    text = root.querySelector<HTMLDetailsElement>("[data-slide-text]")!;
  let page = 0,
    total = 0,
    requested = 1,
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
  }
  async function load(index: number) {
    if (loading || signal.aborted || index < 1 || (total && index > total)) return;
    requested = index;
    loading = true;
    buttons();
    stage.setAttribute("aria-busy", "true");
    retry.hidden = true;
    status.hidden = false;
    localizeText(status, "creative.assetRenderingSlides", {}, t);
    try {
      const response = await request(creativeAssetsApi.slidePreview(asset, index), { signal });
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
      localizeAttribute(image, "aria-label", "creative.assetSlide", { index }, t);
      page = index;
      total = count;
      localizeText(position, "creative.assetSlidePosition", { index, total }, t);
    } catch {
      if (signal.aborted) return;
      URL.revokeObjectURL(incoming);
      incoming = "";
      localizeText(status, "creative.assetSlideRenderFailed", {}, t);
      retry.hidden = false;
      if (!page) text.open = true;
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
  void load(1);
}
