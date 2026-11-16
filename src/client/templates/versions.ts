import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import { sameTemplateLineage } from "../../shared/templates/catalog.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { PluginApiError } from "../plugins/api.js";
import { errorText, setMessageHtml } from "../i18n.js";

import { managedTemplatesApi as api } from "./api.js";
import { templateState } from "./views.js";

export function createTemplateVersions(t: Translate, select: (item: ManagedTemplate) => void) {
  let host: HTMLElement | null = null,
    current: ManagedTemplate | null = null,
    epoch = 0,
    cursor: string | null = null,
    busy = false;
  let entries: ManagedTemplate[] = [];
  function clear() {
    epoch++;
    host = null;
    current = null;
    cursor = null;
    entries = [];
    busy = false;
  }
  function render(message = "") {
    if (!host) return;
    setMessageHtml(
      host,
      `<p role="status">${e(message || (!entries.length ? t("templates.empty") : ""))}</p>${entries.map((item) => `<button type="button" class="template-version-row" data-template-version="${e(item.key)}"><strong>${e(item.reference.version)}</strong><span>${e(templateState(t, item))}</span><code>${e(item.reference.digest.slice(0, 12))}</code></button>`).join("")}${cursor ? `<button type="button" class="wb-button" data-template-versions-more ${busy ? "disabled" : ""}>${e(t("templates.loadMore"))}</button>` : ""}`,
    );
    host.setAttribute("aria-busy", String(busy));
  }
  async function load(more = false) {
    if (!current || !host || busy) return;
    const generation = epoch,
      item = current,
      ref = item.reference;
    const query = new URLSearchParams({
      search: "id" in ref ? ref.id : ref.packageId,
      limit: "100",
      view: "versions",
    });
    if (more && cursor) query.set("cursor", cursor);
    busy = true;
    render(t("plugins.working"));
    try {
      const page = await api.list(query);
      if (generation !== epoch) return;
      const selected = page.templates.filter((value) => sameTemplateLineage(ref, value.reference));
      entries = more ? [...entries, ...selected] : selected;
      cursor = page.nextCursor;
      busy = false;
      render();
    } catch (error) {
      if (generation === epoch) {
        busy = false;
        render(errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"));
      }
    }
  }
  return {
    clear,
    async mount(target: HTMLElement, item: ManagedTemplate) {
      clear();
      host = target;
      current = item;
      target.onclick = (event) => {
        const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
        if (!button || button.disabled || busy) return;
        if (button.hasAttribute("data-template-versions-more")) void load(true);
        else {
          const value = entries.find((entry) => entry.key === button.dataset.templateVersion);
          if (value) select(value);
        }
      };
      await load();
    },
  };
}
