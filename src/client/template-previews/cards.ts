import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import { templatePreviewApi } from "./api.js";
import { templatePreviewSupported } from "./builtins.js";
import { getBrowserI18n } from "../i18n.js";
/** A bounded read queue warms visible covers. Viewing a library never starts a build or raster task. */
export async function loadTemplatePreviewCovers(
  host: HTMLElement,
  items: readonly ManagedTemplate[],
  current: () => boolean,
) {
  const queue = items.filter((item) => templatePreviewSupported(item) && item.state.enabled);
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length && current()) {
        const item = queue.shift()!;
        try {
          const result = await templatePreviewApi.lookup(item.key, getBrowserI18n().locale);
          if (!current() || result.job?.phase !== "ready" || !result.job.images.home) continue;
          const card = [...host.querySelectorAll<HTMLElement>("[data-template-key]")].find(
            (node) => node.dataset.templateKey === item.key,
          );
          const cover = card?.querySelector(".template-cover");
          if (!cover) continue;
          const img = document.createElement("img");
          img.alt = "";
          img.loading = "lazy";
          img.className = "template-cover-image";
          img.decoding = "async";
          img.src = "/api/template-previews/image?" + new URLSearchParams({ id: result.job.id, view: "home" });
          cover.replaceChildren(img);
        } catch {
          /* A cover is optional; the detail panel reports actionable preview failures. */
        }
      }
    }),
  );
}
