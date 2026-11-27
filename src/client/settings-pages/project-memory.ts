import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { MemoryPolicy } from "../../shared/project-memory/contracts.js";
import { mountMemoryLanguage } from "./memory-language.js";
import { readContentAccess } from "../content-access/api.js";
import { harnessApi } from "../harness/api.js";
import { createRuntimeModelField } from "../harness/model-field.js";
import { messageHtml, setMessageHtml } from "../i18n.js";

export function createProjectMemorySettings(t: Translate) {
  const request = harnessApi(t);
  let lifetime: AbortController | undefined;
  let selection: AbortController | undefined;
  let activeModel: ReturnType<typeof createRuntimeModelField> | undefined;

  function hide() {
    lifetime?.abort();
    selection?.abort();
    activeModel?.close();
  }

  function show(host: HTMLElement) {
    hide();
    const ready = new AbortController();
    lifetime = ready;
    const m = (
      id: Extract<MessageId, `projects.memory${string}` | "common.pageLoading" | "common.retry" | "common.save">,
    ) => messageHtml(id, {}, t);
    setMessageHtml(
      host,
      `<section class="settings-body"><header class="resource-heading">
      <div><h1>${m("projects.memorySettings")}</h1><p>${m("projects.memoryHint")}</p></div></header>
      <p data-memory-status role="status">${m("common.pageLoading")}</p>
      <button type="button" data-memory-retry class="wb-button" hidden>${m("common.retry")}</button>
      <div class="wb-form" data-memory-settings-fields><label class="wb-field" data-memory-project-field hidden><span>${m("projects.memorySettingsProject")}</span>
        <select data-memory-settings-project></select></label>
      <div data-memory-project-language></div><div data-memory-project-policy></div></div></section>`,
    );
    const notice = host.querySelector<HTMLElement>("[data-memory-status]")!;
    const reload = host.querySelector<HTMLButtonElement>("[data-memory-retry]")!;
    const picker = host.querySelector<HTMLSelectElement>("[data-memory-settings-project]")!;
    const policyHost = host.querySelector<HTMLElement>("[data-memory-project-policy]")!;

    function project() {
      selection?.abort();
      activeModel?.close();
      const current = new AbortController();
      selection = current;
      const signal = AbortSignal.any([ready.signal, current.signal]);
      const path = "/api/projects/" + encodeURIComponent(picker.value) + "/memory-policy";
      mountMemoryLanguage(host.querySelector<HTMLElement>("[data-memory-project-language]")!, t, signal, picker.value);
      let policy: MemoryPolicy | undefined;
      let mounted = false;
      let saving = false;
      const model = createRuntimeModelField(t, "project-memory", refreshControls, "project-memory", {
        hint: null,
        noEffort: "projects.memoryModelControlsEffort",
      });
      activeModel = model;
      setMessageHtml(
        policyHost,
        `<form class="wb-form">
        <label class="wb-choice"><input data-memory-write type="checkbox" disabled><span>${m("projects.memoryWrite")}</span></label>
        <label class="wb-choice"><input data-memory-recall type="checkbox" disabled><span>${m("projects.memoryRecall")}</span></label>
        <label class="wb-choice"><input data-memory-model-enable type="checkbox" disabled><span>${m("projects.memoryModelEnable")}</span></label>
        <p class="wb-help">${m("projects.memoryModelHint")}</p>
        <fieldset class="wb-field" data-memory-model-fields hidden disabled>${model.html()}</fieldset>
        <div class="resource-actions"><button class="wb-button primary" data-memory-save type="submit" disabled>
          ${m("common.save")}</button></div></form>`,
      );
      const form = policyHost.querySelector("form")!;
      const write = form.querySelector<HTMLInputElement>("[data-memory-write]")!;
      const recall = form.querySelector<HTMLInputElement>("[data-memory-recall]")!;
      const enabled = form.querySelector<HTMLInputElement>("[data-memory-model-enable]")!;
      const fields = form.querySelector<HTMLFieldSetElement>("[data-memory-model-fields]")!;
      const save = form.querySelector<HTMLButtonElement>("[data-memory-save]")!;
      function refreshControls() {
        if (signal.aborted) return;
        const disabled = !policy || saving;
        write.disabled = recall.disabled = enabled.disabled = disabled;
        fields.hidden = !enabled.checked;
        fields.disabled = disabled || !enabled.checked;
        model.setLocked(fields.disabled);
        save.disabled = disabled || (enabled.checked && !model.ready());
        if (enabled.checked && !mounted && policy) {
          mounted = true;
          void model.mount(fields, policy.model?.selection ?? undefined);
        }
      }
      enabled.onchange = refreshControls;

      async function load(preserve = false) {
        reload.hidden = true;
        notice.textContent = t("common.pageLoading");
        try {
          const value = await request<MemoryPolicy>(path, "GET", undefined, signal);
          if (signal.aborted) return;
          policy = value;
          if (!preserve) {
            write.checked = policy.write;
            recall.checked = policy.recall;
            enabled.checked = policy.model?.enabled === true;
          }
          notice.textContent = "";
        } catch (error) {
          if (signal.aborted) return;
          notice.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
          reload.onclick = () => void load(preserve);
          reload.hidden = false;
        } finally {
          if (!signal.aborted) refreshControls();
        }
      }

      form.onsubmit = async (event) => {
        event.preventDefault();
        if (!policy || save.disabled) return;
        saving = true;
        const payload: MemoryPolicy = {
          revision: policy.revision,
          write: write.checked,
          recall: recall.checked,
          model: {
            enabled: enabled.checked,
            selection: enabled.checked ? model.read() : (policy.model?.selection ?? null),
          },
        };
        picker.disabled = true;
        refreshControls();
        notice.textContent = t("common.pageLoading");
        try {
          policy = await request<MemoryPolicy>(path, "PATCH", payload, signal);
          if (!signal.aborted) notice.textContent = t("projects.memorySaved");
        } catch (error) {
          if (signal.aborted) return;
          notice.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
          if (error && typeof error === "object" && "code" in error && error.code === "conflict") {
            policy = undefined;
            reload.onclick = () => void load(true);
            reload.hidden = false;
          }
        } finally {
          if (!signal.aborted) {
            saving = picker.disabled = false;
            refreshControls();
          }
        }
      };
      void load();
    }
    async function list() {
      reload.hidden = true;
      try {
        const { projects } = await readContentAccess(ready.signal);
        if (ready.signal.aborted) return;
        const choices = projects.filter(({ id }) => id !== "personal");
        if (!choices.length) {
          notice.textContent = t("projects.memorySettingsEmpty");
          return;
        }
        picker.replaceChildren(...choices.map(({ id, name }) => new Option(name, id)));
        const initial = new URLSearchParams(location.search).get("project");
        if (initial && choices.some(({ id }) => id === initial)) picker.value = initial;
        host.querySelector<HTMLElement>("[data-memory-project-field]")!.hidden = false;
        picker.onchange = () => {
          const url = new URL(location.href);
          if (url.pathname === "/settings/memory-settings") {
            url.searchParams.set("project", picker.value);
            history.replaceState(history.state, "", url);
          }
          project();
        };
        project();
      } catch (error) {
        if (ready.signal.aborted) return;
        notice.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
        reload.hidden = false;
        reload.onclick = () => void list();
      }
    }
    void list();
  }
  return { show, hide };
}
