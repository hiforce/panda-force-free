import { reasoningLabel } from "./reasoning-label.js";
import { runtimeModels, changeRuntimeSelection } from "../../shared/engine/runtime-selection.js";
import { escapeHtml } from "../../shared/html.js";
import type { HarnessCatalog, HarnessPingResult } from "../../shared/harness/contracts.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { setMessageHtml } from "../i18n.js";
import { harnessApi } from "./api.js";
import { confirmAction } from "../confirmation-dialog.js";
import { mountReasoningSlider } from "../session-controls/reasoning-slider.js";
/** Runtime selection precedes its scoped model and account configuration. No executable or secret is accepted here. */
export function createHarnessSettings(t: Translate) {
  const api = harnessApi(t),
    pingResults = new Map<string, HarnessPingResult>(),
    pingRequests = new Map<string, string>(),
    drafts = new Map<
      string,
      {
        name: string;
        profileId: string;
        model: string;
        effort: string;
        enabled: boolean;
        botEnabled: boolean;
        makeDefault: boolean;
      }
    >();
  const localeObserver = new MutationObserver(() => {
    if (host) {
      capture();
      render();
    }
  });
  let host: HTMLElement | null = null,
    catalog: HarnessCatalog | null = null,
    selected: string | null = null,
    epoch = 0,
    busy = false,
    testingRuntime = "",
    message = "";
  const label = (key: Extract<MessageId, `harness.${string}`> | "settings.pageLoading") => escapeHtml(t(key));
  const field = (caption: Extract<MessageId, `harness.${string}`> | "settings.pageLoading", control: string) =>
    `<label class="wb-field"><span>${label(caption)}</span>${control}</label>`;
  function draft() {
    const runtime = catalog?.runtimes.find((value) => value.id === selected),
      id = selected ?? "new";
    if (!drafts.has(id))
      drafts.set(id, {
        name: runtime?.name ?? "",
        profileId: runtime?.profileId ?? catalog?.profiles[0]?.id ?? "",
        model: runtime?.defaultModel ?? "",
        effort: runtime?.defaultEffort ?? "",
        enabled: runtime?.enabled ?? true,
        botEnabled: runtime?.botEnabled !== false,
        makeDefault: runtime?.isDefault ?? false,
      });
    return drafts.get(id)!;
  }
  function pingResult(id: string) {
    const result = pingResults.get(id);
    if (!result || pingRequests.has(id)) return "";
    const status = t(
      result.status === "complete"
        ? "harness.pingPassed"
        : result.status === "uncertain"
          ? "harness.pingUncertain"
          : "harness.pingFailed",
      { seconds: (result.elapsedMs / 1000).toFixed(1) },
    );
    const error = result.error
      ? t(`harness.error${result.error[0]!.toUpperCase()}${result.error.slice(1)}` as MessageId)
      : "";
    return `<div class="harness-ping-result" role="status"><strong>${escapeHtml(status)}</strong>${result.reply ? `<p>${escapeHtml(result.reply)}</p>` : ""}${error ? `<p>${escapeHtml(error)}</p>` : ""}</div>`;
  }
  function pingAction(id: string) {
    return testingRuntime === id
      ? "harness.pinging"
      : pingRequests.has(id)
        ? "harness.pingRecover"
        : pingResults.has(id)
          ? "harness.pingAgain"
          : "harness.ping";
  }
  function render() {
    if (!host) return;
    let content: string;
    if (catalog) {
      if (selected === null)
        content = `<p>${label("harness.connectionHint")}</p><p class="harness-hint">${label("harness.pingHint")}</p><div class="harness-runtime-list">${catalog.runtimes.map((runtime) => `<div class="harness-runtime-row"><button type="button" class="composer-settings-row" data-runtime-id="${escapeHtml(runtime.id)}"><span><strong>${escapeHtml(runtime.name)}</strong><small>${escapeHtml(t(`harness.${runtime.status}`))}${runtime.isDefault ? ` · ${label("harness.default")}` : ""}</small></span></button><button type="button" class="wb-button" data-harness-ping="${escapeHtml(runtime.id)}" ${runtime.enabled ? "" : "data-runtime-disabled disabled"} aria-label="${escapeHtml(t("harness.pingNamed", { name: runtime.name, action: t(pingAction(runtime.id)) }))}">${label(pingAction(runtime.id))}</button>${pingResult(runtime.id)}</div>`).join("")}</div><button type="button" class="wb-button" data-harness-add>${label("harness.add")}</button><p class="harness-hint">${label("harness.defaultHint")}</p>`;
      else {
        const runtime = catalog.runtimes.find((value) => value.id === selected),
          value = draft();
        const models = runtime ? runtimeModels(runtime) : [],
          model = models.find((model) => model.id === value.model);
        const option = (id: string, name: string, current: string) =>
          `<option value="${escapeHtml(id)}"${id === current ? " selected" : ""}>${escapeHtml(name)}</option>`;
        content = `<button type="button" class="wb-button" data-harness-back>${label("harness.back")}</button><form class="wb-form harness-form">${field("harness.name", `<input name="runtimeName" maxlength="80" required value="${escapeHtml(value.name)}">`)}${field("harness.profile", `<select name="profileId" ${runtime ? "disabled" : ""}>${catalog.profiles.map((profile) => option(profile.id, profile.name, value.profileId)).join("")}</select>`)}<p class="harness-hint">${label("harness.accountHint")}</p>${field("harness.model", `<select name="model">${option("", t("harness.automatic"), value.model)}${models.map((model) => option(model.id, model.label, value.model)).join("")}${value.model && !model ? option(value.model, value.model, value.model) : ""}</select>`)}<div class="wb-field"><input type="hidden" name="effort"><div data-runtime-effort-slider></div></div><label class="wb-choice"><input type="checkbox" name="enabled" ${value.enabled ? "checked" : ""}>${label("harness.enabled")}</label><label class="wb-choice"><input type="checkbox" name="botEnabled" ${value.botEnabled ? "checked" : ""}>${label("harness.botEnabled")}</label>${runtime?.botSupported === false ? `<p class="harness-hint">${label("harness.botUnsupported")}</p>` : ""}<label class="wb-choice"><input type="checkbox" name="makeDefault" ${value.makeDefault ? "checked" : ""}>${label("harness.makeDefault")}</label><p class="harness-hint">${label("harness.inheritedWorkspace")}</p><div class="harness-actions">${runtime && !runtime.isDefault ? `<button class="wb-button danger" type="button" data-harness-remove>${label("harness.remove")}</button>` : ""}${runtime ? `<button type="button" class="wb-button" data-harness-probe>${label(busy ? "harness.checking" : "harness.probe")}</button>` : ""}<button class="wb-button primary" type="submit">${label("harness.save")}</button></div>${runtime?.isDefault ? `<p class="harness-hint">${label("harness.removeDefaultHint")}</p>` : ""}</form>`;
      }
    } else content = `<p role="status">${label("settings.pageLoading")}</p>`;
    setMessageHtml(
      host,
      `<section class="harness-settings"><header class="settings-page-heading"><h1>${label("harness.title")}</h1></header>${message ? `<p role="status" class="harness-feedback">${escapeHtml(message)}</p>` : ""}${content}</section>`,
    );
    for (const button of host.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = busy || button.hasAttribute("data-runtime-disabled");
    if (busy)
      for (const control of host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"))
        control.disabled = true;
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-runtime-id]"))
      button.onclick = () => {
        capture();
        selected = button.dataset.runtimeId!;
        message = "";
        render();
      };
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-harness-ping]"))
      button.onclick = () => {
        const id = button.dataset.harnessPing!,
          generation = epoch;
        if (busy) return;
        if (!pingRequests.has(id)) pingRequests.set(id, crypto.randomUUID());
        testingRuntime = id;
        void operation(async () => {
          const result = await api<HarnessPingResult>(
            `/api/harness-runtimes/${encodeURIComponent(id)}/ping`,
            "POST",
            { requestId: pingRequests.get(id) },
            AbortSignal.timeout(180000),
          );
          const updated = await api<HarnessCatalog>("/api/harness-runtimes").catch(() => null);
          return () => {
            pingResults.set(id, result);
            pingRequests.delete(id);
            if (updated) catalog = updated;
          };
        }).finally(() => {
          testingRuntime = "";
          if (generation === epoch) {
            render();
            host?.querySelector<HTMLButtonElement>(`[data-harness-ping="${CSS.escape(id)}"]`)?.focus();
          }
        });
      };
    host.querySelector<HTMLButtonElement>("[data-harness-add]")?.addEventListener("click", () => {
      selected = "new";
      message = "";
      render();
    });
    host.querySelector<HTMLButtonElement>("[data-harness-back]")?.addEventListener("click", () => {
      capture();
      selected = null;
      message = "";
      render();
    });
    host.querySelector<HTMLButtonElement>("[data-harness-remove]")?.addEventListener("click", async () => {
      const runtime = catalog?.runtimes.find((entry) => entry.id === selected);
      if (!runtime || runtime.isDefault || busy) return;
      if (
        !(await confirmAction({
          title: "harness.remove",
          message: "harness.removeConfirm",
          values: { name: runtime.name },
          confirmText: "harness.remove",
          cancelText: "common.cancel",
          returnFocus: () => host?.querySelector<HTMLButtonElement>("[data-harness-remove]") ?? null,
        }))
      )
        return;
      if (selected !== runtime.id) return;
      void operation(async () => {
        const result = await api<HarnessCatalog>(`/api/harness-runtimes/${encodeURIComponent(runtime.id)}`, "DELETE", {
          revision: runtime.revision,
        });
        return () => {
          catalog = result;
          drafts.delete(runtime.id);
          selected = null;
          message = t("harness.removed");
          window.dispatchEvent(new Event("panda-force:harness-runtimes-updated"));
        };
      });
    });
    host.querySelector<HTMLButtonElement>("[data-harness-probe]")?.addEventListener(
      "click",
      () =>
        void operation(async () => {
          capture();
          const result = await api<HarnessCatalog>(
            `/api/harness-runtimes/${encodeURIComponent(selected!)}/probe`,
            "POST",
            {},
          );
          return () => {
            catalog = result;
          };
        }),
    );
    const form = host.querySelector<HTMLFormElement>("form");
    if (form) {
      const value = draft(),
        runtime = catalog?.runtimes.find((entry) => entry.id === selected),
        efforts = runtime && runtimeModels(runtime).find((model) => model.id === value.model)?.efforts,
        effort = form.querySelector<HTMLInputElement>('[name="effort"]')!;
      effort.value = value.effort;
      mountReasoningSlider(
        form.querySelector<HTMLElement>("[data-runtime-effort-slider]")!,
        [
          { id: "", label: t("harness.automatic") },
          ...(efforts ?? []).map((option) => ({ id: option.id, label: reasoningLabel(option.id, t, option.label) })),
          ...(value.effort && !efforts?.some((option) => option.id === value.effort)
            ? [{ id: value.effort, label: reasoningLabel(value.effort, t) }]
            : []),
        ],
        value.effort,
        t("harness.effort"),
        (selected) => {
          value.effort = effort.value = selected;
        },
        busy || !value.model,
      );
    }
    form?.addEventListener("input", capture);
    form?.querySelector<HTMLSelectElement>('[name="model"]')?.addEventListener("change", () => {
      capture();
      const runtime = catalog?.runtimes.find((entry) => entry.id === selected);
      if (runtime)
        draft().effort = changeRuntimeSelection(
          { runtimeId: runtime.id, model: draft().model, effort: draft().effort },
          runtime,
          draft().model,
        ).effort;
      render();
    });
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      capture();
      void operation(async () => {
        const value = draft(),
          savedSelection = selected!,
          runtime = catalog!.runtimes.find((runtime) => runtime.id === selected);
        const result = await api<HarnessCatalog>(
          runtime ? `/api/harness-runtimes/${encodeURIComponent(runtime.id)}` : "/api/harness-runtimes",
          runtime ? "PATCH" : "POST",
          {
            id: runtime?.id,
            revision: runtime?.revision ?? 0,
            name: value.name,
            profileId: value.profileId,
            enabled: value.enabled,
            botEnabled: value.botEnabled,
            access: "administrators",
            defaultModel: value.model || null,
            defaultEffort: value.effort || null,
            makeDefault: value.makeDefault,
          },
        );
        return () => {
          catalog = result;
          drafts.delete(savedSelection);
          selected = null;
          message = t("harness.saved");
          window.dispatchEvent(new Event("panda-force:harness-runtimes-updated"));
        };
      });
    });
  }
  function capture() {
    if (!host || selected === null) return;
    const form = host.querySelector<HTMLFormElement>("form");
    if (!form) return;
    const value = draft();
    value.name = form.querySelector<HTMLInputElement>('[name="runtimeName"]')!.value;
    value.profileId = form.querySelector<HTMLSelectElement>('[name="profileId"]')!.value;
    value.model = form.querySelector<HTMLSelectElement>('[name="model"]')!.value;
    value.effort = form.querySelector<HTMLInputElement>('[name="effort"]')!.value;
    value.enabled = form.querySelector<HTMLInputElement>('[name="enabled"]')!.checked;
    value.botEnabled = form.querySelector<HTMLInputElement>('[name="botEnabled"]')!.checked;
    value.makeDefault = form.querySelector<HTMLInputElement>('[name="makeDefault"]')!.checked;
  }
  async function operation(work: () => Promise<() => void>) {
    if (busy) return;
    busy = true;
    message = "";
    const current = epoch;
    render();
    try {
      const apply = await work();
      if (current === epoch) apply();
    } catch (error) {
      if (current === epoch) message = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      if (current === epoch) {
        busy = false;
        render();
      }
    }
  }
  function hide() {
    capture();
    epoch++;
    host = null;
    busy = false;
    localeObserver.disconnect();
  }
  function show(target: HTMLElement) {
    if (host === target) return;
    host = target;
    localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    const current = ++epoch;
    catalog = null;
    render();
    void api<HarnessCatalog>("/api/harness-runtimes").then(
      (value) => {
        if (current === epoch) {
          catalog = value;
          render();
        }
      },
      (error) => {
        if (current === epoch) {
          message = error instanceof Error ? error.message : t("harness.errorUnavailable");
          render();
        }
      },
    );
  }
  return { show, hide };
}
