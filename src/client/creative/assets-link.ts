import type { CreativeAsset } from "../../shared/creative/assets.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { copyPlainText } from "../clipboard-text.js";
import { DocumentApiError } from "../documents/api.js";
import { errorText, localizeText, setMessageHtml, setOpaqueText } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";
import { creativeAssetsApi } from "./assets-api.js";

/** Explicit link sharing leaves the current viewer, playback and draft untouched. */
export function bindAssetLink(body: HTMLElement, asset: CreativeAsset, t: Translate, signal: AbortSignal) {
  const button = body.querySelector<HTMLButtonElement>("[data-asset-get-link]"),
    panel = body.querySelector<HTMLElement>("[data-asset-link]");
  if (!button || !panel) return;
  let link: { url: string; expiresAt: number } | undefined;
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    panel.hidden = false;
    try {
      if (!link || link.expiresAt <= Date.now() + 60000) {
        localizeText(panel, "documents.loading", {}, t);
        link = await creativeAssetsApi.link(asset, signal);
      }
      if (signal.aborted || !body.isConnected) return;
      setMessageHtml(
        panel,
        `<p role="status" data-asset-link-notice></p><label class="wb-field"><span>${e(t("creative.assetLinkLabel"))}</span><input class="wb-input" data-asset-link-url readonly></label><button type="button" class="wb-button" data-asset-link-copy>${e(t("creative.assetLinkCopy"))}</button><p role="status" data-asset-link-copied></p>`,
      );
      const field = panel.querySelector<HTMLInputElement>("[data-asset-link-url]")!;
      field.value = link.url;
      field.onclick = () => field.select();
      localizeText(
        panel.querySelector("[data-asset-link-notice]"),
        "creative.assetLinkLifetime",
        { expires: link.expiresAt },
        t,
      );
      const copy = panel.querySelector<HTMLButtonElement>("[data-asset-link-copy]")!;
      copy.onclick = async () => {
        copy.disabled = true;
        try {
          if (!link || link.expiresAt <= Date.now() + 60000) link = await creativeAssetsApi.link(asset, signal);
          if (signal.aborted) return;
          field.value = link.url;
          localizeText(
            panel.querySelector("[data-asset-link-notice]"),
            "creative.assetLinkLifetime",
            { expires: link.expiresAt },
            t,
          );
          try {
            await copyPlainText(link.url);
          } catch {
            field.focus();
            field.select();
            localizeText(panel.querySelector("[data-asset-link-copied]"), "creative.assetLinkManualCopy", {}, t);
            return;
          }
          if (!signal.aborted) localizeText(panel.querySelector("[data-asset-link-copied]"), "common.copied", {}, t);
        } catch (error) {
          if (!signal.aborted)
            setOpaqueText(
              panel.querySelector("[data-asset-link-copied]"),
              errorText(error instanceof DocumentApiError ? error.payload : null, t, "documents.unavailable"),
            );
        } finally {
          copy.disabled = false;
        }
      };
      field.focus({ preventScroll: true });
    } catch (error) {
      if (!signal.aborted)
        setOpaqueText(
          panel,
          errorText(error instanceof DocumentApiError ? error.payload : null, t, "documents.unavailable"),
        );
    } finally {
      button.disabled = false;
    }
  };
}
