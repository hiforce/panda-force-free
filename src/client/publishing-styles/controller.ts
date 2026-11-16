import type { Translate } from "../../shared/i18n/messages.js";
import type { PluginRegistrySnapshot } from "../../shared/plugins/registry.js";
import { documentApi } from "../documents/api.js";
import { publishingApiFor } from "../publishing/api.js";
import { pluginApi, PluginApiError } from "../plugins/api.js";
import { createPackageManager } from "../plugins/controller.js";
import { createTemplateLibrary } from "../plugins/library/controller.js";
import { errorText, setMessageHtml } from "../i18n.js";

import { escapeHtml as e } from "../../shared/html.js";
import { styleKey, styleMatches, type PublishingStyle } from "./catalog.js";
import { stylesFrame, styleCard } from "./views.js";
import { createStyleDetail } from "./detail.js";

/** Page lifetime, catalog requests and preview requests have independent generations. */
export function createPublishingStyleCenter(t: Translate) {
  let host: HTMLElement | null = null,
    epoch = 0,
    busy = false;
  let tab: PublishingStyle["kind"] = "site",
    styles: PublishingStyle[] = [];
  let registry: PluginRegistrySnapshot = { revision: 0, packages: [] };
  const packages = createPackageManager(t, {
    id: "stylesPackageDialog",
    onClose: () => void refresh(),
    onChange: () => void refresh(),
  });
  const library = createTemplateLibrary(t, () => void refresh(), "stylesTemplateLibrary");
  const detail = createStyleDetail(
    t,
    () => registry,
    (draft) => library.open(draft),
  );
  function notice(node: HTMLElement, value: string, failed = false) {
    const target = node.querySelector<HTMLElement>("[data-style-notice]");
    if (target) {
      target.textContent = value;
      target.dataset.error = String(failed);
    }
  }
  function report(node: HTMLElement, error: unknown) {
    notice(
      node,
      errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
      true,
    );
  }
  function render() {
    if (!host) return;
    const query = host.querySelector<HTMLInputElement>("[data-style-search]")!.value;
    const filter = host.querySelector<HTMLSelectElement>("[data-style-filter]")!.value;
    const items = styles.filter((style) => style.kind === tab && styleMatches(style, query, filter, t));
    setMessageHtml(host.querySelector("[data-style-grid]")!, items.map((style) => styleCard(t, style)).join(""));
    if (!busy) notice(host, items.length ? "" : t("plugins.stylesEmpty"));
  }
  function filters() {
    if (!host) return;
    const options =
      tab === "site"
        ? ["hexo", "docusaurus"]
        : ["html", "plain", "x-post", "x-thread", "x-article", "wechat", "toutiao"];
    setMessageHtml(
      host.querySelector("[data-style-filter]")!,
      `<option value="all">${e(t("plugins.stylesAll"))}</option>${options.map((option) => `<option value="${e(option)}">${e(option)}</option>`).join("")}`,
    );
    for (const button of host.querySelectorAll<HTMLElement>("[data-style-tab]"))
      button.setAttribute("aria-selected", String(button.dataset.styleTab === tab));
    render();
  }
  async function refresh() {
    if (!host) return;
    const target = host,
      generation = ++epoch;
    busy = true;
    target.setAttribute("aria-busy", "true");
    notice(target, t("plugins.working"));
    try {
      const [sites, channels, installed] = await Promise.all([
        documentApi.themes(),
        publishingApiFor().templates(),
        pluginApi.list(),
      ]);
      if (generation !== epoch) return;
      styles = [
        ...sites.themes.map((value): PublishingStyle => ({ kind: "site", value })),
        ...channels.templates.map((value): PublishingStyle => ({ kind: "channel", value })),
      ];
      registry = installed;
      busy = false;
      render();
    } catch (error) {
      if (generation === epoch) report(target, error);
    } finally {
      if (generation === epoch) {
        busy = false;
        target.setAttribute("aria-busy", "false");
      }
    }
  }
  return {
    show(target: HTMLElement) {
      host = target;
      setMessageHtml(host, stylesFrame(t));
      host.onclick = (event) => {
        const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
        if (!button || button.disabled) return;
        if (button.dataset.styleTab) {
          tab = button.dataset.styleTab as PublishingStyle["kind"];
          filters();
          return;
        }
        const action = button.dataset.styleAction;
        if (action === "refresh") void refresh();
        if (action === "packages") packages.open();
        if (action === "library") library.open();
        if (action === "preview") {
          const style = styles.find((item) => styleKey(item) === button.dataset.styleKey);
          if (style) detail.open(style);
        }
      };
      host.oninput = (event) => {
        if (event.target instanceof Element && event.target.matches("[data-style-search]")) render();
      };
      host.onchange = (event) => {
        if (event.target instanceof Element && event.target.matches("[data-style-filter]")) render();
      };
      filters();
      void refresh();
    },
    hide() {
      epoch++;
      detail.close();
      host = null;
      packages.close();
      library.close(false);
    },
  };
}
