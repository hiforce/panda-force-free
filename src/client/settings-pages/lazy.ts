import type { Translate } from "../../shared/i18n/messages.js";
import { DocumentRuntimeLoader, RuntimeLoadError } from "../documents/runtime-loader.js";
import { isModuleNetworkError } from "../documents/module-network-error.js";
import { setMessageHtml } from "../i18n.js";
import { escapeHtml } from "../../shared/html.js";
import type { settingsPageFactories } from "./runtime.js";
import type { SettingsPageMount } from "./contracts.js";

const runtime = new DocumentRuntimeLoader<typeof import("./runtime.js")>({
  prime: async () => {},
  isTransferFailure: isModuleNetworkError,
  evaluate: (entry) => (entry ? import("/settings-pages.bundle.js?retry=1") : import("/settings-pages.bundle.js")),
});
/** One cached view owns each page; leaving always clears its secrets and invalidates late module loads. */
export function createLazySettingsPage(t: Translate, kind: keyof typeof settingsPageFactories) {
  let epoch = 0,
    mountedHost: HTMLElement | null = null,
    mountedKey = "",
    mountOptions: SettingsPageMount | undefined,
    fatal = false,
    view: { show(host: HTMLElement, options?: SettingsPageMount): void; hide(): void } | null = null;
  function hide() {
    epoch++;
    mountedHost = null;
    mountedKey = "";
    view?.hide();
  }
  function failure(host: HTMLElement, retryable: boolean) {
    setMessageHtml(
      host,
      `<p role="status">${escapeHtml(t(retryable ? "settings.pageLoadFailed" : "settings.pageReloadRequired"))}</p><button type="button" class="wb-button">${escapeHtml(t(retryable ? "common.retry" : "common.reloadWorkspace"))}</button>`,
    );
    host.querySelector("button")!.onclick = () => {
      mountedHost = null;
      return retryable ? show(host, mountOptions) : location.reload();
    };
  }
  function mount(host: HTMLElement, create?: (t: Translate) => NonNullable<typeof view>) {
    try {
      view ??= create!(t);
      view.show(host, mountOptions);
    } catch {
      fatal = true;
      failure(host, false);
    }
  }
  function show(host: HTMLElement, options?: SettingsPageMount) {
    const key = JSON.stringify(options ?? {});
    if (mountedHost === host && mountedKey === key) return;
    hide();
    mountedHost = host;
    mountedKey = key;
    mountOptions = options;
    if (fatal) return failure(host, false);
    const current = epoch;
    if (view) return mount(host);
    setMessageHtml(host, `<p role="status">${escapeHtml(t("settings.pageLoading"))}</p>`);
    void runtime.load().then(
      (module) => {
        if (current !== epoch) return;
        mount(host, module.settingsPageFactories[kind]);
      },
      (error) => {
        if (current !== epoch) return;
        const retryable = error instanceof RuntimeLoadError && error.retryable;
        fatal = !retryable;
        failure(host, retryable);
      },
    );
  }
  return { show, hide };
}
