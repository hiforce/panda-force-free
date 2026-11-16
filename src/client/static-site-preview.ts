import type { Translate } from "../shared/i18n/messages.js";
import { errorText } from "./i18n.js";

/** Preview fetches as the signed-in parent; the opaque frame receives only self-contained output. */
export interface StaticSitePreviewApi {
  pages(id: string): Promise<{ pages: string[] }>;
  preview(id: string, path: string): Promise<string>;
  errorPayload(error: unknown): unknown;
}
export function createStaticSitePreview(t: Translate, api: StaticSitePreviewApi) {
  let epoch = 0,
    current = "",
    host: HTMLElement | null = null;
  function clear() {
    epoch++;
    current = "";
    host = null;
  }
  async function mount(target: HTMLElement, id: string) {
    if (host === target && current === id) return;
    clear();
    host = target;
    current = id;
    const generation = epoch,
      label = document.createElement("label"),
      select = document.createElement("select"),
      status = document.createElement("p");
    label.textContent = t("builds.previewPage");
    label.append(select);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.referrerPolicy = "no-referrer";
    frame.title = t("builds.previewLabel");
    target.replaceChildren(label, status, frame);
    status.textContent = t("builds.loading");
    let loading = 0;
    const report = (error: unknown) => {
      status.textContent = errorText(api.errorPayload(error), t, "builds.unavailable");
    };
    async function read() {
      const request = ++loading;
      status.textContent = t("builds.loading");
      try {
        const html = await api.preview(id, select.value);
        if (generation !== epoch || request !== loading) return;
        frame.srcdoc = html;
        status.textContent = "";
      } catch (error) {
        if (generation === epoch && request === loading) report(error);
      }
    }
    try {
      const { pages } = await api.pages(id);
      if (generation !== epoch) return;
      for (const path of pages) {
        const option = document.createElement("option");
        option.value = path;
        option.textContent = path;
        select.append(option);
      }
      select.value = pages.includes("index.html") ? "index.html" : pages[0] || "";
      select.onchange = () => {
        void read();
      };
      if (pages.length) await read();
    } catch (error) {
      if (generation === epoch) report(error);
    }
  }
  return { mount, clear };
}
