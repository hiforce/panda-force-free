import { coverFailed } from "./covers.js";
import type { createTemplateScreenshotPanel } from "../template-previews/panel.js";
import { loadTemplateDetails } from "./lazy-details.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import { PluginApiError } from "../plugins/api.js";
import { errorText, setMessageHtml, messageHtml } from "../i18n.js";

import type { TemplateManagerAdapter, ManagedTemplateDetail } from "./ports.js";
import { detailFrame } from "./views.js";
import type { createTemplateVersions } from "./versions.js";
import type { SkillWorkspaceActions } from "../skill-workspace/ports.js";

import { codexIcon } from "../codex-icons.js";

export function createManagedTemplateDetail(
  t: Translate,
  adapters: () => Promise<readonly TemplateManagerAdapter[]>,
  changed: () => void,
  workspace: () => SkillWorkspaceActions | null = () => null,
) {
  let versions: ReturnType<typeof createTemplateVersions> | null = null;
  const dialog = document.createElement("dialog");
  dialog.className = "package-dialog template-detail-dialog";
  dialog.id = "managedTemplateDialog";
  dialog.setAttribute("aria-labelledby", "managedTemplateTitle");
  document.body.append(dialog);
  dialog.addEventListener("error", coverFailed, true);
  let screenshots: ReturnType<typeof createTemplateScreenshotPanel> | null = null;
  let epoch = 0,
    busy = false,
    entry: ManagedTemplate | null = null,
    loaded: ManagedTemplateDetail | null = null,
    previous: HTMLElement | null = null;
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  function close() {
    epoch++;
    versions?.clear();
    loaded?.clearPreview?.();
    screenshots?.clear();
    screenshots = null;
    loaded = null;
    entry = null;
    busy = false;
    dialog.close();
    dialog.replaceChildren();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    previous = null;
  }
  function notice(value: string, failed = false) {
    const node = get("[data-template-detail-notice]");
    if (node) {
      node.textContent = value;
      node.dataset.error = String(failed);
    }
  }
  function controls() {
    dialog.setAttribute("aria-busy", String(busy));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = busy && button.dataset.templateDetail !== "close";
    syncWorkspace();
  }
  async function run(task: () => Promise<void>) {
    if (!entry || busy || !dialog.open) return;
    const generation = epoch;
    busy = true;
    controls();
    notice(t("plugins.working"));
    try {
      await task();
      if (generation === epoch) notice("");
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
  async function open(item: ManagedTemplate) {
    close();
    entry = item;
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMessageHtml(dialog, detailFrame(t, item, workspace() ? workspace()!.isPinned(item.key) : undefined));
    dialog.showModal();
    const generation = epoch;
    await run(async () => {
      const values = await adapters();
      if (generation !== epoch) return;
      const registry = new Map(values.map((adapter) => [adapter.registry, adapter]));
      if (registry.size !== values.length) throw new PluginApiError(503, { messageId: "templates.adapterMissing" });
      const adapter = registry.get(item.reference.registry);
      if (!adapter) throw new PluginApiError(503, { messageId: "templates.adapterMissing" });
      const value = await adapter.load(item);
      if (generation !== epoch) {
        value.clearPreview?.();
        return;
      }
      loaded = value;
      get("[data-template-hint]").textContent = value.hint || "";
      await value.overview?.(get("[data-template-overview]"));
      if (generation !== epoch) return;
      const buttons: Record<string, boolean> = {
        apply: Boolean(value.apply && item.state.enabled && item.state.active),
        edit: Boolean(value.edit && item.actions.editor),
        export: Boolean(value.export && item.actions.export),
        toggle: Boolean(value.setEnabled && item.actions.setEnabled),
        activate: Boolean(value.activate && item.actions.activate),
      };
      for (const [action, show] of Object.entries(buttons)) get(`[data-template-detail="${action}"]`).hidden = !show;
      syncWorkspace();
      get<HTMLButtonElement>('[data-template-detail="preview"]').hidden = !value.preview || !item.actions.preview;
    });
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.onclick = (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-template-detail]") : null;
    if (!button || button.disabled) return;
    const action = button.dataset.templateDetail;
    if (action === "close") return close();
    if (action === "categorize" && entry && workspace()) {
      workspace()!.assign(entry);
      return;
    }
    if (action === "pin" && entry && workspace()) {
      void workspace()!
        .togglePin(entry)
        .then(syncWorkspace)
        .catch(() => syncWorkspace());
      return;
    }
    if (!loaded || !entry) return;
    const current = loaded,
      selected = entry,
      generation = epoch;
    void run(async () => {
      if (action === "preview" || action === "overview" || action === "versions") {
        current.clearPreview?.();
        screenshots?.clear();
        versions?.clear();
        get("[data-template-overview]").hidden = action !== "overview";
        get("[data-template-preview]").hidden = action !== "preview";
        get("[data-template-versions]").hidden = action !== "versions";
        for (const tab of dialog.querySelectorAll<HTMLElement>(
          '[data-template-detail="overview"],[data-template-detail="preview"],[data-template-detail="versions"]',
        ))
          tab.setAttribute("aria-pressed", String(tab.dataset.templateDetail === action));
        if (action === "preview") {
          const tools = await loadTemplateDetails();
          if (generation !== epoch) return;
          if (tools.templatePreviewSupported(selected))
            screenshots ??= tools.createTemplateScreenshotPanel(t, selected);
          const target = get("[data-template-preview]");
          target.replaceChildren();
          if (screenshots) {
            const gallery = document.createElement("section"),
              disclosure = document.createElement("details"),
              summary = document.createElement("summary"),
              output = document.createElement("div");
            summary.textContent = t("plugins.sampleTitle");
            disclosure.className = "template-static-sample";
            disclosure.append(summary, output);
            target.append(gallery, disclosure);
            await screenshots.mount(gallery);
            if (generation !== epoch) return;
            await current.preview?.(output);
          } else await current.preview?.(target);
        }
        if (action === "versions") {
          const tools = await loadTemplateDetails();
          if (generation !== epoch) return;
          versions ??= tools.createTemplateVersions(t, (item) => void open(item));
          await versions.mount(get("[data-template-versions]"), selected);
        }
      } else if (action === "apply") {
        await current.apply?.();
        if (generation === epoch) close();
      } else if (action === "export") await current.export?.();
      else if (action === "edit") {
        const navigate = await current.edit?.();
        if (generation === epoch && navigate) {
          close();
          navigate();
        }
      } else if (action === "toggle" || action === "activate") {
        if (action === "toggle") await current.setEnabled?.(!selected.state.exportEnabled);
        else await current.activate?.();
        changed();
        if (generation === epoch) close();
      }
    });
  };
  function syncWorkspace() {
    if (!entry || !dialog.open || !workspace()) return;
    const button = get<HTMLButtonElement>('[data-template-detail="pin"]');
    if (!button) return;
    const pinned = workspace()!.isPinned(entry.key);
    button.setAttribute("aria-pressed", String(pinned));
    setMessageHtml(
      button,
      codexIcon("pin") + messageHtml(pinned ? "skillWorkspace.unpin" : "skillWorkspace.pin", undefined, t),
    );
    button.disabled = busy || !workspace()!.ready();
    get<HTMLButtonElement>('[data-template-detail="categorize"]').disabled = busy || !workspace()!.ready();
  }
  return { open, close, syncWorkspace };
}
