import { executorCredentialTarget } from "../../shared/creation/media-executors.js";
import type { CreationMediaCredential, CreationMediaPreset } from "../../shared/creation/media-executors.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";
import { harnessApi } from "../harness/api.js";
import { localizeText, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { executorIcon } from "./executor-brands.js";
import { credentialEndpoint, executorEndpoint, providerName, type ExecutorCatalog } from "./executor-catalog.js";
import { createExecutorCredentialDialog } from "./executor-credential-dialog.js";

export function createExecutorCredentialSettings(t: Translate) {
  const api = harnessApi(t);
  const editor = createExecutorCredentialDialog(t);
  const m = (id: MessageId) => messageHtml(id, {}, t);
  let lifetime: AbortController | undefined;
  let add: HTMLButtonElement | undefined;

  function hide() {
    lifetime?.abort();
    lifetime = undefined;
    editor.close();
    if (add) add.onclick = null;
    add = undefined;
  }

  function show(host: HTMLElement) {
    hide();
    lifetime = new AbortController();
    const { signal } = lifetime;
    const addButton = host.parentElement!.querySelector<HTMLButtonElement>("[data-credential-add]")!;
    add = addButton;
    addButton.disabled = true;
    setMessageHtml(
      host,
      `
      <p class="executor-page-description">${m("creation.credentialHelp")}</p>
      <p class="executor-form-notice" role="status" data-credential-feedback hidden></p>
      <div data-credential-list></div>`,
    );
    const listHost = host.querySelector<HTMLElement>("[data-credential-list]")!;
    const feedback = host.querySelector<HTMLElement>("[data-credential-feedback]")!;
    let catalog: ExecutorCatalog | undefined;
    let deleting = false;

    function announce(id?: MessageId) {
      feedback.hidden = !id;
      if (id) localizeText(feedback, id, {}, t);
    }

    function row(item: CreationMediaCredential, preset?: CreationMediaPreset) {
      const node = document.createElement("li");
      node.className = "executor-row executor-credential-row";
      node.dataset.credentialRow = item.id;
      const use = catalog?.executors.filter((executor) => executor.credentialId === item.id).length ?? 0;
      setMessageHtml(
        node,
        `
        <span class="executor-row-icon">${preset ? executorIcon(preset.provider) : codexIcon("shield")}</span>
        <div class="executor-row-copy"><h2></h2><p></p></div>
        <div class="executor-row-actions">
          <button type="button" class="wb-button" data-credential-edit>${m("creation.credentialEdit")}</button>
          <button type="button" class="wb-button" data-credential-remove>${m("creation.credentialRemove")}</button>
        </div>
        <div class="executor-remove-confirm" hidden>
          <p>${m(use ? "creation.credentialRemoveInUse" : "creation.credentialRemoveConfirm")}</p>
          <div class="executor-row-actions">
            <button type="button" class="wb-button" data-credential-cancel>${m("common.cancel")}</button>
            <button type="button" class="wb-button" data-credential-confirm>${m("creation.credentialRemove")}</button>
          </div>
        </div>`,
      );
      setOpaqueText(node.querySelector("h2")!, item.name);
      setOpaqueText(
        node.querySelector(".executor-row-copy p")!,
        [preset ? providerName(t, preset) : item.target, t("creation.credentialUses", { count: use })].join(" · "),
      );
      const edit = node.querySelector<HTMLButtonElement>("[data-credential-edit]")!;
      const remove = node.querySelector<HTMLButtonElement>("[data-credential-remove]")!;
      const panel = node.querySelector<HTMLElement>(".executor-remove-confirm")!;
      const cancel = node.querySelector<HTMLButtonElement>("[data-credential-cancel]")!;
      const confirm = node.querySelector<HTMLButtonElement>("[data-credential-confirm]")!;
      edit.disabled = !preset;
      edit.onclick = () => open(edit, item);
      remove.onclick = () => {
        panel.hidden = false;
        remove.hidden = true;
        cancel.focus();
      };
      cancel.onclick = () => {
        panel.hidden = true;
        remove.hidden = false;
        remove.focus();
      };
      confirm.onclick = async () => {
        if (deleting || !catalog) return;
        deleting = confirm.disabled = cancel.disabled = true;
        try {
          await api(
            credentialEndpoint,
            "DELETE",
            { id: item.id, revision: item.revision },
            AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          );
          if (signal.aborted) return;
          catalog.credentials = catalog.credentials?.filter((value) => value.id !== item.id);
          render();
          announce("creation.credentialRemoved");
          addButton.focus();
        } catch (error) {
          if (!signal.aborted)
            announce(
              (error as { code?: string }).code === "conflict"
                ? "creation.credentialConflict"
                : "creation.credentialTryAgain",
            );
        } finally {
          deleting = confirm.disabled = cancel.disabled = false;
        }
      };
      return node;
    }

    function render() {
      const entries = catalog?.credentials ?? [];
      const choices = new Map(catalog?.presets.map((preset) => [executorCredentialTarget(preset), preset]));
      addButton.disabled = catalog?.configured === false || !choices.size;
      if (!entries.length) {
        setMessageHtml(
          listHost,
          `<div class="executor-empty">
          ${codexIcon("shield", "executor-empty-icon")}
          <h2>${m("creation.credentialEmpty")}</h2>
          <p>${m(catalog?.configured === false ? "creation.mediaWorkerUnavailable" : "creation.credentialEmptyHelp")}</p>
        </div>`,
        );
        return;
      }
      const list = document.createElement("ul");
      list.className = "executor-list";
      list.append(...entries.map((item) => row(item, choices.get(item.target))));
      listHost.replaceChildren(list);
    }

    function open(opener: HTMLElement, existing?: CreationMediaCredential) {
      if (!catalog) return;
      editor.open({
        opener,
        presets: catalog.presets,
        existing,
        saved(credential) {
          if (!catalog || signal.aborted) return;
          catalog.credentials = [
            ...(catalog.credentials ?? []).filter((item) => item.id !== credential.id),
            credential,
          ].sort((a, b) => a.name.localeCompare(b.name));
          render();
          announce("creation.credentialSaved");
        },
        focusFallback: () =>
          listHost.querySelector<HTMLButtonElement>(
            `[data-credential-row="${existing?.id ?? ""}"] [data-credential-edit]`,
          ) ?? addButton,
      });
    }

    async function load() {
      setMessageHtml(listHost, `<p role="status">${m("settings.pageLoading")}</p>`);
      try {
        const data = await api<ExecutorCatalog>(
          executorEndpoint,
          "GET",
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(25000)]),
        );
        if (signal.aborted) return;
        catalog = data;
        render();
      } catch {
        if (signal.aborted) return;
        setMessageHtml(
          listHost,
          `<div class="content-workspace-recovery" role="status">
          <p>${m("creation.credentialTryAgain")}</p><button type="button" class="wb-button">${m("common.retry")}</button>
        </div>`,
        );
        listHost.querySelector("button")!.onclick = () => void load();
      }
    }

    addButton.onclick = () => open(addButton);
    void load();
  }
  return { show, hide };
}
