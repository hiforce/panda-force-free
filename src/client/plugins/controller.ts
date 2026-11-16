import type { Translate } from "../../shared/i18n/messages.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";
import { PACKAGE_LIMITS } from "../../shared/plugins/contracts.js";
import type { PluginInstallReview, PluginRegistrySnapshot } from "../../shared/plugins/registry.js";
import { setMessageHtml, errorText } from "../i18n.js";

import { pluginApi, PluginApiError } from "./api.js";
import { packageFrame, packageReview, packageVersions, packageAudit } from "./views.js";
import { createTemplateLibrary } from "./library/controller.js";

/** Package bytes and approval exist only for this modal session, never in browser drafts or storage. */
export function createPackageManager(t: Translate, options: { id?: string; onClose?(): void; onChange?(): void } = {}) {
  const dialog = document.createElement("dialog");
  dialog.id = options.id || "documentPackageDialog";
  dialog.className = "package-dialog";
  document.body.append(dialog);
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  let epoch = 0,
    busy = false,
    previous: Element | null = null;
  let snapshot: PluginRegistrySnapshot = { revision: 0, packages: [] };
  let selected: { value: PluginPackage; review: PluginInstallReview } | null = null;
  const library = createTemplateLibrary(
    t,
    () => {
      if (dialog.open) void run((generation) => refresh(generation));
    },
    options.id ? options.id + "Library" : undefined,
  );
  function close() {
    const wasOpen = dialog.open;
    library.close(false);
    const restore = dialog.open ? previous : null;
    previous = null;
    epoch++;
    selected = null;
    dialog.close();
    dialog.replaceChildren();
    if (restore instanceof HTMLElement && restore.isConnected) restore.focus({ preventScroll: true });
    if (wasOpen) options.onClose?.();
  }
  function controls() {
    dialog.setAttribute("aria-busy", String(busy));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = button.dataset.packageAction === "close" ? false : busy;
    const file = get<HTMLInputElement>("#packageFile");
    if (file) file.disabled = busy;
    const review = get<HTMLButtonElement>('[data-package-action="review"]');
    if (review) review.disabled = busy || !file?.files?.length;
  }
  function notice(text: string, failed = false) {
    const target = get<HTMLElement>("#packageNotice");
    target.textContent = text;
    target.dataset.error = String(failed);
  }
  async function run(task: (generation: number) => Promise<void>) {
    if (busy || !dialog.open) return;
    const generation = epoch;
    busy = true;
    controls();
    notice(t("plugins.working"));
    try {
      await task(generation);
    } catch (error) {
      if (generation === epoch)
        notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        );
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  async function refresh(generation: number, value?: PluginRegistrySnapshot) {
    const [next, audit] = await Promise.all([value ? Promise.resolve(value) : pluginApi.list(), pluginApi.audit()]);
    if (generation !== epoch) return;
    snapshot = next;
    if (selected && selected.review.revision !== snapshot.revision) {
      selected = null;
      get("#packageReview").replaceChildren();
    }
    setMessageHtml(get("#packageVersions"), packageVersions(t, snapshot));
    setMessageHtml(get("#packageAudit"), packageAudit(t, audit.events));
    notice("");
  }
  async function review(generation: number) {
    const file = get<HTMLInputElement>("#packageFile").files?.[0];
    if (!file) return;
    if (file.size > PACKAGE_LIMITS.jsonBytes) throw new PluginApiError(413, { messageId: "plugins.packageTooLarge" });
    let value: PluginPackage;
    try {
      value = JSON.parse(await file.text());
    } catch {
      throw new PluginApiError(400, { messageId: "plugins.invalidPackage" });
    }
    if (generation !== epoch) return;
    await offer(value, generation);
  }
  async function offer(value: PluginPackage, generation: number) {
    const reviewed = await pluginApi.review(value);
    if (generation !== epoch) return;
    selected = { value, review: reviewed };
    setMessageHtml(get("#packageReview"), packageReview(t, reviewed));
    get<HTMLFormElement>("#packageApproval").onsubmit = (event) => {
      event.preventDefault();
      if (!selected || !get<HTMLInputElement>("#packageAccept").checked) return;
      const approved = selected;
      void run(async (generation) => {
        const result = await pluginApi.install(approved.value, approved.review);
        options.onChange?.();
        if (generation !== epoch) return;
        selected = null;
        get("#packageReview").replaceChildren();
        get<HTMLInputElement>("#packageFile").value = "";
        await refresh(generation, result);
        if (generation === epoch) notice(t("plugins.installed"));
      });
    };
    notice(t("plugins.readyForReview"));
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-package-action]") : null;
    if (!button || button.disabled) return;
    const action = button.dataset.packageAction;
    if (action === "close") return close();
    if (action === "library") return library.open(selected?.value);
    void run(async (generation) => {
      if (action === "review") return review(generation);
      if (action === "refresh") return refresh(generation);
      const id = button.dataset.packageId!,
        version = button.dataset.packageVersion!;
      const result =
        action === "activate"
          ? await pluginApi.activate(id, version, snapshot.revision)
          : await pluginApi.state(id, version, action === "enable", snapshot.revision);
      options.onChange?.();
      if (generation !== epoch) return;
      await refresh(generation, result);
      if (generation === epoch) notice(t("plugins.stateUpdated"));
    });
  });
  return {
    close,
    open(value?: PluginPackage, focusPackageId?: string) {
      close();
      previous = document.activeElement;
      busy = false;
      setMessageHtml(dialog, packageFrame(t));
      dialog.setAttribute("aria-labelledby", "packageHeading");
      get("h2").id = "packageHeading";
      get<HTMLInputElement>("#packageFile").onchange = () => {
        selected = null;
        get("#packageReview").replaceChildren();
        notice("");
        controls();
      };
      dialog.showModal();
      void run(async (generation) => {
        await refresh(generation);
        if (focusPackageId && generation === epoch) {
          const version = [...dialog.querySelectorAll<HTMLElement>("[data-package-identity]")].find(
            (item) => item.dataset.packageIdentity === focusPackageId,
          );
          version?.focus();
        }
        if (value && generation === epoch) await offer(value, generation);
      });
    },
  };
}
