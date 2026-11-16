import type { Translate } from "../../shared/i18n/messages.js";
import type { PluginRegistrySnapshot } from "../../shared/plugins/registry.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";
import type { PublicationFormat } from "../../shared/publishing/content.js";
import { pluginApi, PluginApiError } from "../plugins/api.js";
import { errorText, setMessageHtml } from "../i18n.js";

import { stylePackage, copyChannelTemplate, copySiteTheme, nextPackageDraft, type PublishingStyle } from "./catalog.js";
import { styleDetail } from "./views.js";
import { channelSamplePreview, siteSamplePreview } from "./preview.js";
import { styleSample } from "./api.js";
import { createSiteSampleMonitor } from "../site-samples/controller.js";

/** Owns one detail dialog and its async lifetime; the gallery supplies catalog access and draft navigation. */
export function createStyleDetail(
  t: Translate,
  registry: () => PluginRegistrySnapshot,
  configure: (draft: PluginPackage) => void,
) {
  let previewEpoch = 0;
  let selected: PublishingStyle | null = null,
    previous: HTMLElement | null = null;
  const siteMonitor = createSiteSampleMonitor(t, {
    illustration(target) {
      if (selected?.kind === "site") siteSamplePreview(target, selected.value, t);
    },
  });
  const dialog = document.createElement("dialog");
  dialog.id = "publishingStylePreview";
  dialog.className = "package-dialog styles-preview-dialog";
  dialog.setAttribute("aria-labelledby", "stylePreviewTitle");
  document.body.append(dialog);
  function closePreview() {
    previewEpoch++;
    siteMonitor.clear();
    dialog.close();
    dialog.replaceChildren();
    selected = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    previous = null;
  }
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
  async function previewSample() {
    if (!selected || !dialog.open) return;
    const style = selected,
      generation = ++previewEpoch;
    const output = dialog.querySelector<HTMLElement>("[data-style-preview]")!;
    notice(dialog, t("plugins.working"));
    output.setAttribute("aria-busy", "true");
    try {
      if (style.kind === "site")
        await siteMonitor.mount(output, {
          kind: "catalog",
          engine: style.value.engine,
          reference: `${style.value.id}@${style.value.version}`,
        });
      else {
        const format = dialog.querySelector<HTMLSelectElement>("[data-style-format]")!.value as PublicationFormat;
        const sample = await styleSample(style.value, format);
        if (generation !== previewEpoch) return;
        channelSamplePreview(output, sample, t);
      }
      if (generation === previewEpoch) notice(dialog, "");
    } catch (error) {
      if (generation === previewEpoch) report(dialog, error);
    } finally {
      if (generation === previewEpoch) output.setAttribute("aria-busy", "false");
    }
  }
  function preview(style: PublishingStyle) {
    closePreview();
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selected = style;
    setMessageHtml(dialog, styleDetail(t, style, Boolean(stylePackage(style, registry()))));
    dialog.showModal();
    void previewSample();
  }
  async function packageAction(action: string) {
    if (!selected) return;
    if (action === "configure" && selected.kind !== "channel") return;
    const style = selected,
      generation = previewEpoch;
    const installed = stylePackage(style, registry());
    notice(dialog, t("plugins.working"));
    try {
      const value = installed
        ? await pluginApi.export(installed.id, installed.version)
        : style.kind === "channel"
          ? copyChannelTemplate(style.value, t)
          : copySiteTheme(style.value, t);
      if (generation !== previewEpoch || !value) return;
      if (action === "configure") {
        const draft = installed
          ? nextPackageDraft(
              value,
              registry()
                .packages.filter((entry) => entry.id === installed.id)
                .map((entry) => entry.version),
            )
          : value;
        if (!draft) throw new PluginApiError(409, { messageId: "plugins.immutableVersion" });
        closePreview();
        configure(draft);
        return;
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${value.manifest.id}-${value.manifest.version}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice(dialog, t("plugins.stylesExported"));
    } catch (error) {
      if (generation === previewEpoch) report(dialog, error);
    }
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePreview();
  });
  dialog.addEventListener("change", (event) => {
    if (event.target instanceof Element && event.target.matches("[data-style-format]")) void previewSample();
  });
  dialog.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-style-action]") : null;
    if (!button || button.disabled) return;
    if (button.dataset.styleAction === "close") closePreview();
    else void packageAction(button.dataset.styleAction!);
  });
  return { open: preview, close: closePreview };
}
