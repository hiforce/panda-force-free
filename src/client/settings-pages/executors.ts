import { executorKinds } from "../../shared/creation/media-executors.js";
import type { CreationMediaExecutor, ExecutorCategory } from "../../shared/creation/media-executors.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { harnessApi } from "../harness/api.js";
import { localizeAttribute, localizeText, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { categoryIcons, categoryLabels, executorCategory, executorEndpoint, providerName } from "./executor-catalog.js";
import type { ExecutorCatalog } from "./executor-catalog.js";
import { executorIcon } from "./executor-brands.js";
import { createExecutorDialog } from "./executor-dialog.js";

type Filter = "all" | ExecutorCategory;
const filters: readonly Filter[] = ["all", ...executorKinds, "cli"];

export function createExecutorSettings(t: Translate) {
  const api = harnessApi(t);
  let request: AbortController | undefined;
  let catalog: ExecutorCatalog | undefined;
  let loading = false;
  let failed = false;
  let filter: Filter = "all";
  let host: HTMLElement | undefined;
  let add: HTMLButtonElement | undefined;
  let deleting: string | undefined;
  let feedback: MessageId | undefined;
  const editor = createExecutorDialog(t, load);

  function render() {
    if (!host || !add) return;
    const status = host.querySelector<HTMLElement>("[data-executor-settings-status]")!;
    const region = host.querySelector<HTMLElement>("[data-executor-list]")!;
    add.disabled = !catalog || catalog.configured === false;
    status.hidden = !feedback;
    if (feedback) localizeText(status, feedback, {}, t);
    host.querySelectorAll<HTMLButtonElement>("[data-executor-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.executorFilter === filter));
    });
    if (loading && !catalog) {
      setMessageHtml(
        region,
        `<div class="busy-status busy-status-panel" role="status">
        <span class="busy-indicator" aria-hidden="true"></span>${messageHtml("settings.pageLoading", {}, t)}
      </div>`,
      );
      return;
    }
    if (failed && !catalog) {
      setMessageHtml(
        region,
        `<div class="content-workspace-recovery" role="status">
        <p>${messageHtml("creation.mediaLoadFailed", {}, t)}</p>
        <button type="button" class="wb-button" data-executor-retry>${messageHtml("common.retry", {}, t)}</button>
      </div>`,
      );
      region.querySelector("button")!.onclick = () => void load();
      return;
    }
    const listed = catalog?.executors.filter((item) => filter === "all" || category(item) === filter) ?? [];
    if (listed.length === 0) {
      setMessageHtml(
        region,
        `
        <div class="executor-empty">
          ${codexIcon(filter === "all" ? "plug" : categoryIcons[filter], "executor-empty-icon")}
          <h2>${messageHtml(filter === "all" ? "creation.mediaEmpty" : "creation.executorEmptyCategory", {}, t)}</h2>
          <p>${messageHtml(catalog?.configured === false ? "creation.mediaWorkerUnavailable" : "creation.executorEmptyHelp", {}, t)}</p>
        </div>`,
      );
      return;
    }
    const list = document.createElement("ul");
    list.className = "executor-list";
    list.append(...listed.map(row));
    region.replaceChildren(list);
  }

  async function load() {
    request?.abort();
    const current = new AbortController();
    request = current;
    loading = true;
    failed = false;
    render();
    try {
      const data = await api<ExecutorCatalog>(
        executorEndpoint,
        "GET",
        undefined,
        AbortSignal.any([current.signal, AbortSignal.timeout(25000)]),
      );
      if (!current.signal.aborted) catalog = data;
    } catch {
      if (!current.signal.aborted) {
        failed = true;
        if (catalog) feedback = "creation.mediaLoadFailed";
      }
    } finally {
      if (!current.signal.aborted) {
        loading = false;
        render();
      }
    }
    return current.signal.aborted ? undefined : catalog;
  }

  function category(item: CreationMediaExecutor) {
    return executorCategory(
      item.kind,
      catalog?.presets.find((entry) => entry.id === item.preset),
    );
  }

  function edit(trigger: HTMLButtonElement, existing?: CreationMediaExecutor) {
    if (!catalog) return;
    editor.open(trigger, {
      catalog,
      category: filter === "all" ? undefined : filter,
      existing,
      async saved() {
        feedback = "creation.executorSaved";
        await load();
      },
      focusFallback: () =>
        Array.from(host?.querySelectorAll<HTMLButtonElement>("[data-media-configure]") ?? []).find(
          (button) => button.dataset.mediaConfigure === (existing?.id ?? ""),
        ) ?? add,
    });
  }

  function row(item: CreationMediaExecutor) {
    const node = document.createElement("li");
    const preset = catalog?.presets.find((entry) => entry.id === item.preset);
    const kind = category(item);
    node.className = "executor-row";
    setMessageHtml(
      node,
      `
      ${preset?.provider ? `<span class="executor-row-icon">${executorIcon(preset.provider)}</span>` : codexIcon(categoryIcons[kind], "executor-row-icon")}
      <div class="executor-row-copy"><h2></h2><p></p></div>
      <span class="executor-state" data-state="${item.status === "connected" && !item.credentialUnavailable ? "connected" : "unverified"}">
        ${messageHtml(item.credentialUnavailable ? "creation.credentialUnavailable" : item.status === "connected" ? "creation.executorConnected" : "creation.executorUnverified", {}, t)}
      </span>
      <div class="executor-row-actions">
        <button type="button" class="wb-button" data-media-configure>${messageHtml("creation.executorConfigure", {}, t)}</button>
        <button type="button" class="wb-button" data-executor-remove>${messageHtml("creation.mediaRemoveExecutor", {}, t)}</button>
      </div>
      <div class="executor-remove-confirm" hidden>
        <p>${messageHtml("creation.executorRemoveConfirm", {}, t)}</p>
        <div class="executor-row-actions">
          <button type="button" class="wb-button" data-executor-cancel>${messageHtml("common.cancel", {}, t)}</button>
          <button type="button" class="wb-button" data-executor-confirm>${messageHtml("creation.mediaRemoveExecutor", {}, t)}</button>
        </div>
      </div>`,
    );
    setOpaqueText(node.querySelector("h2")!, item.name);
    const selected = preset?.models.find((model) => model.id === item.model)?.name ?? item.model;
    const metadata = [
      t(categoryLabels[kind]),
      preset && providerName(t, preset),
      selected !== item.name && selected,
      catalog?.credentials?.find((credential) => credential.id === item.credentialId)?.name,
    ].filter(Boolean);
    setOpaqueText(node.querySelector("p")!, metadata.join(" · "));
    const configure = node.querySelector<HTMLButtonElement>("[data-media-configure]")!;
    const remove = node.querySelector<HTMLButtonElement>("[data-executor-remove]")!;
    const confirm = node.querySelector<HTMLElement>(".executor-remove-confirm")!;
    const doRemove = confirm.querySelector<HTMLButtonElement>("[data-executor-confirm]")!;
    const cancel = confirm.querySelector<HTMLButtonElement>("[data-executor-cancel]")!;
    configure.dataset.mediaConfigure = item.id;
    configure.disabled = !preset;
    configure.onclick = () => edit(configure, item);
    remove.onclick = () => {
      confirm.hidden = false;
      remove.hidden = true;
      cancel.focus();
    };
    cancel.onclick = () => {
      confirm.hidden = true;
      remove.hidden = false;
      remove.focus();
    };
    doRemove.onclick = async () => {
      if (deleting) return;
      deleting = item.id;
      doRemove.disabled = cancel.disabled = true;
      try {
        await api(executorEndpoint, "DELETE", { id: item.id, revision: item.revision });
        feedback = "creation.executorRemoved";
        await load();
        add?.focus();
      } catch {
        feedback = "creation.mediaUnavailable";
        const status = host?.querySelector<HTMLElement>("[data-executor-settings-status]");
        if (status) {
          status.hidden = false;
          localizeText(status, feedback, {}, t);
        }
      } finally {
        deleting = undefined;
        doRemove.disabled = cancel.disabled = false;
      }
    };
    return node;
  }

  return {
    show(target: HTMLElement) {
      host = target;
      feedback = undefined;
      setMessageHtml(
        host,
        `
        <p class="executor-page-description">${messageHtml("creation.executorSettingsHelp", {}, t)}</p>
        <div class="executor-filters" role="group">
          ${filters
            .map(
              (item) => `<button type="button" class="wb-button" data-executor-filter="${item}" aria-pressed="false">
              ${codexIcon(item === "all" ? "layout" : categoryIcons[item])}${messageHtml(item === "all" ? "creation.executorAll" : categoryLabels[item], {}, t)}
            </button>`,
            )
            .join("")}
        </div>
        <p class="executor-form-notice" data-executor-settings-status role="status" hidden></p>
        <div data-executor-list></div>`,
      );
      localizeAttribute(host.querySelector(".executor-filters")!, "aria-label", "creation.executorCategory", {}, t);
      add = target.parentElement!.querySelector<HTMLButtonElement>("[data-executor-add]")!;
      add.onclick = (event) => edit(event.currentTarget as HTMLButtonElement);
      host.querySelectorAll<HTMLButtonElement>("[data-executor-filter]").forEach((button) => {
        button.onclick = () => {
          filter = filters.find((item) => item === button.dataset.executorFilter) ?? "all";
          render();
        };
      });
      void load();
    },
    hide() {
      editor.close();
      request?.abort();
      loading = false;
      if (add) {
        add.disabled = true;
        add.onclick = null;
      }
      add = undefined;
      host = undefined;
    },
  };
}
