import { memoryDisplayName } from "../../shared/project-memory/language.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type {
  MemoryRemovalImpact,
  MemorySessionDetail,
  MemorySessionPolicy,
} from "../../shared/project-memory/contracts.js";
import { escapeHtml as escape } from "../../shared/html.js";
import { legacyMemoryPath, type MemoryLegacySessionView } from "../../shared/project-memory/contracts.js";
import { mountLegacyMemoryForm, renderLegacyRecords } from "./memory-legacy.js";
import { confirmAction } from "../confirmation-dialog.js";
import { conversationsPath, harnessApi } from "../harness/api.js";
import { createMemoryPackages, memoryPackageSources } from "../projects/memory-packages.js";
import { memorySourceHref, memoryTeamLink } from "../projects/memory-source-link.js";
import { codexIcon } from "../codex-icons.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { mountMemoryBackfill } from "./memory-backfill.js";

export type SessionMemoryPage = "details" | "settings" | "history" | "legacy-save" | "legacy-details";

export function createSessionMemory(t: Translate) {
  const request = harnessApi(t);
  const materialReader = createMemoryPackages(t);
  let active: HTMLDialogElement | undefined;

  const close = () => {
    materialReader.close();
    active?.close();
  };
  const m = (id: MessageId) => messageHtml(id, {}, t);

  function show(id: string, projectId: string, tab: SessionMemoryPage, trigger: HTMLElement, changed?: () => void) {
    close();
    const dialog = document.createElement("dialog");
    dialog.id = "sessionMemoryDialog";
    dialog.className = "session-dialog session-memory-dialog";
    dialog.setAttribute("aria-labelledby", "sessionMemoryTitle");
    const legacy = tab === "legacy-save" || tab === "legacy-details";
    const title =
      tab === "settings"
        ? "sessions.memorySettings"
        : tab === "legacy-save"
          ? "sessions.memoryManualSave"
          : "sessions.memoryView";
    setMessageHtml(
      dialog,
      `<header class="session-dialog-heading">
        <h2 id="sessionMemoryTitle" tabindex="-1">${m(title)}</h2>
        <button type="button" class="icon-button" data-close-memory ${messageAttributes("aria-label", "common.close", {}, t)}>${codexIcon("x")}</button>
       </header>
       <div class="session-dialog-body"><p data-session-memory-status role="status" tabindex="-1"></p>
        <button type="button" class="wb-button" data-memory-load-retry hidden>${m("common.retry")}</button>
        <div data-session-memory-body></div>
       </div>`,
    );
    const url = (legacy ? legacyMemoryPath : conversationsPath + "/") + encodeURIComponent(id);
    const cancel = new AbortController();
    const status = dialog.querySelector<HTMLElement>("[data-session-memory-status]")!;
    const body = dialog.querySelector<HTMLElement>("[data-session-memory-body]")!;
    const loadRetry = dialog.querySelector<HTMLButtonElement>("[data-memory-load-retry]")!;
    loadRetry.onclick = () => void load();
    const showError = (error: unknown) => {
      if (!cancel.signal.aborted)
        status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    };
    const field = (name: "write" | "recall", label: MessageId, value: boolean | null, inherited: boolean) => {
      // The options use plain text so the native picker can render them consistently.
      const choice = (key: MessageId, v: string, selected: boolean) =>
        `<option value="${v}" ${selected ? "selected" : ""}>${escape(t(key))}</option>`;
      return `<label class="wb-field"><span>${m(label)}</span>
        <select data-memory-field="${name}">
          ${choice(inherited ? "sessions.memoryInheritOn" : "sessions.memoryInheritOff", "", value === null)}
          ${choice("sessions.memoryEnable", "on", value === true)}
          ${choice("sessions.memoryDisable", "off", value === false)}
         </select></label>`;
    };

    function renderSettings(settings: MemorySessionPolicy) {
      const { policy, source } = settings;
      setMessageHtml(
        body,
        `<form class="wb-form" data-session-memory-form>
        ${field("write", "projects.memoryWrite", source.write, policy.write)}
        ${field("recall", "projects.memoryRecall", source.recall, policy.recall)}
        <div class="session-memory-actions"><button type="submit" class="wb-button primary">${m("common.save")}</button></div>
      </form>
      <section class="session-memory-withdraw"><p>${m("sessions.memoryWithdrawHint")}</p>
        <button class="wb-button danger" type="button" data-memory-withdraw>${m("sessions.memoryWithdraw")}</button>
      </section>`,
      );
      const form = body.querySelector<HTMLFormElement>("form")!;
      const save = form.querySelector<HTMLButtonElement>("button")!;
      const revoke = body.querySelector<HTMLButtonElement>("[data-memory-withdraw]")!;
      const selections = [...form.querySelectorAll<HTMLSelectElement>("select")];
      const value = (select: HTMLSelectElement) => (select.value ? select.value === "on" : null);
      const disable = (locked: boolean) => {
        save.disabled = revoke.disabled = locked;
        for (const select of selections) select.disabled = locked;
      };
      const submit = async (withdrawing: boolean) => {
        if (save.disabled) return;
        disable(true);
        status.textContent = t("common.pageLoading");
        try {
          const impact = withdrawing
            ? await request<MemoryRemovalImpact>(url + "/memory-removal-impact", "GET", undefined, cancel.signal)
            : undefined;
          if (cancel.signal.aborted) return;
          if (
            impact &&
            !(await confirmAction({
              title: "sessions.memoryWithdraw",
              message: "sessions.memoryWithdrawHint",
              detailMessage: "sessions.memoryWithdrawImpact",
              detailValues: {
                stops: impact.stops,
                retains: impact.retains,
                recovers: impact.recovers,
                pauses: impact.pauses,
              },
              confirmText: "sessions.memoryWithdraw",
              cancelText: "common.cancel",
              returnFocus: revoke,
            }))
          ) {
            status.textContent = "";
            return;
          }
          if (cancel.signal.aborted) return;
          const next = await request<MemorySessionPolicy["source"]>(
            url + "/memory-policy",
            "PATCH",
            {
              revision: source.revision,
              write: withdrawing ? source.write : value(selections[0]!),
              recall: withdrawing ? source.recall : value(selections[1]!),
              revoke: withdrawing,
              ...(impact ? { impactToken: impact.token } : {}),
            },
            cancel.signal,
          );
          if (cancel.signal.aborted) return;
          source.revision = next.revision;
          source.write = next.write;
          source.recall = next.recall;
          source.generation = next.generation;
          if (withdrawing) {
            selections[0]!.value = next.write === null ? "" : next.write ? "on" : "off";
            selections[1]!.value = next.recall === null ? "" : next.recall ? "on" : "off";
          }
          status.textContent = t(withdrawing ? "sessions.memoryWithdrawn" : "projects.memorySaved");
          changed?.();
        } catch (error) {
          showError(error);
          if (
            !cancel.signal.aborted &&
            typeof error === "object" &&
            error &&
            "code" in error &&
            error.code === "conflict"
          ) {
            const fresh = await request<MemorySessionPolicy>(
              url + "/memory-policy",
              "GET",
              undefined,
              cancel.signal,
            ).catch(() => null);
            if (!fresh || cancel.signal.aborted) return;
            Object.assign(source, fresh.source);
            status.textContent = t("sessions.memoryImpactChanged");
          }
        } finally {
          disable(false);
          if (withdrawing && dialog.open) revoke.focus({ preventScroll: true });
        }
      };
      form.onsubmit = (event) => {
        event.preventDefault();
        void submit(false);
      };
      revoke.onclick = () => void submit(true);
    }
    const sourceLink = (source: { conversationId: string; messageId: string }) =>
      `<a data-session-memory-source href="${escape(memorySourceHref(projectId, source))}">${m("projects.memorySourcePosition")}</a>`;
    const bindSourceLinks = (host: HTMLElement) => {
      for (const link of host.querySelectorAll<HTMLAnchorElement>("[data-session-memory-source]"))
        link.onclick = (event) => {
          if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
            dialog.close();
        };
    };
    function renderContributions(host: HTMLElement, contributions: MemorySessionDetail["contributions"]) {
      const entries = contributions.entries
        .filter(({ state }) => state === "active")
        .map((entry) => {
          const links = entry.sources.filter((source) => source.conversationId === id).map(sourceLink);
          return `<li><strong data-i18n-ignore>${escape(entry.title ?? memoryDisplayName(entry.key))}</strong> <span data-i18n-ignore>${escape(entry.scope)}</span>
          <code data-i18n-ignore>${escape(entry.value ?? "")}</code>
          ${links.length ? `<ul><li>${links.join("</li><li>")}</li></ul>` : ""}</li>`;
        })
        .join("");
      setMessageHtml(
        host,
        `${entries ? `<ul>${entries}</ul>` : `<p>${m("sessions.memoryNoContribution")}</p>`}
        ${contributions.pending ? `<p>${messageHtml("sessions.memoryPending", { count: contributions.pending }, t)}</p>` : ""}
        ${contributions.failed ? `<p>${messageHtml("sessions.memoryFailed", { count: contributions.failed }, t)}</p><button class="wb-button" type="button" data-retry-memory>${m("common.retry")}</button>` : ""}`,
      );
      bindSourceLinks(host);
      const retry = host.querySelector<HTMLButtonElement>("[data-retry-memory]");
      if (retry)
        retry.onclick = async () => {
          retry.disabled = true;
          try {
            await request(url + "/memory-refresh", "POST", {}, cancel.signal);
            const latest = await request<MemorySessionDetail>(url + "/memory", "GET", undefined, cancel.signal);
            if (!cancel.signal.aborted) {
              renderContributions(host, latest.contributions);
              host.querySelector<HTMLElement>("[data-retry-memory], a")?.focus({ preventScroll: true });
            }
          } catch (error) {
            showError(error);
            retry.disabled = false;
          }
        };
    }
    function renderDetails(detail: MemorySessionDetail) {
      const { contributions, recalls } = detail;

      const recallsMarkup = recalls
        .map((recall, recallIndex) => {
          if (recall.status === "indexUnavailable") return `<li>${m("sessions.memoryRecallIndexUnavailable")}</li>`;
          const label = recall.status === "sent" ? "sessions.memoryRecallSent" : "sessions.memoryRecallPossible";
          const sources = new Map(
            recall.references.flatMap((reference) =>
              reference.sources.map((source) => [source.messageId, source] as const),
            ),
          );
          const links = [...sources.values()].map(sourceLink);
          const packages = memoryPackageSources(t, [
            ...new Set(recall.references.flatMap((reference) => reference.packages ?? [])),
          ]);
          const shared = recall.references
            .filter((reference) => reference.team)
            .map(
              (reference) =>
                `<li><a data-session-memory-source href="${escape(memoryTeamLink(projectId, reference.id))}">${m("projects.memoryTeamTitle")}</a></li>`,
            )
            .join("");
          const materials = recall.references
            .map(({ material, visual }, index) =>
              material
                ? `<li><button type="button" class="memory-material-link" aria-haspopup="dialog"
              data-recalled-material="${recallIndex}:${index}" data-i18n-ignore>${escape(material.material.title)}</button>${material.recognition === "ocr" ? ` <small>${m("projects.memoryMaterialRecognizedText")}</small>` : ""}${visual && recall.status === "sent" ? ` <small>${m("sessions.memoryRecallVisual")}</small>` : ""}</li>`
                : "",
            )
            .join("");
          const manual = recall.references.some((reference) => reference.manual?.length)
            ? `<li>${m("projects.memoryManualSource")}</li>`
            : "";
          return `<li>${m(label)}${links.length || packages || materials || shared || manual ? `<ul>${links.map((link) => `<li>${link}</li>`).join("")}${packages}${materials}${shared}${manual}</ul>` : ` <span>${m("sessions.memoryRecallWithdrawn")}</span>`}</li>`;
        })
        .join("");
      setMessageHtml(
        body,
        `<section><h3>${m("sessions.memoryContributed")}</h3><div data-memory-contribution-results></div>
        <details class="session-memory-backfill" data-memory-backfill></details>
      </section>
      <section><h3>${m("sessions.memoryUsed")}</h3>${recallsMarkup ? `<ul>${recallsMarkup}</ul>` : `<p>${m("sessions.memoryNoRecall")}</p>`}</section>`,
      );
      const results = body.querySelector<HTMLElement>("[data-memory-contribution-results]")!;
      renderContributions(results, contributions);
      bindSourceLinks(body);
      mountMemoryBackfill(
        body.querySelector<HTMLDetailsElement>("[data-memory-backfill]")!,
        url + "/memory-backfill",
        t,
        request,
        cancel.signal,
        async () => {
          const latest = await request<MemorySessionDetail>(url + "/memory", "GET", undefined, cancel.signal).catch(
            () => null,
          );
          if (latest && !cancel.signal.aborted) {
            renderContributions(results, latest.contributions);
            changed?.();
          }
        },
      );
      if (tab === "history") body.querySelector<HTMLDetailsElement>("[data-memory-backfill]")!.open = true;
      for (const trigger of body.querySelectorAll<HTMLButtonElement>("[data-recalled-material]")) {
        trigger.onclick = () => {
          const indices = trigger.dataset.recalledMaterial!.split(":").map(Number);
          const material = recalls[indices[0]!]?.references[indices[1]!]?.material;
          if (material) materialReader.showMaterial(projectId, material, trigger);
        };
      }
    }
    async function load() {
      loadRetry.hidden = true;
      status.textContent = t("common.pageLoading");
      try {
        if (tab === "legacy-save") {
          status.textContent = "";
          mountLegacyMemoryForm({ host: body, status, url, signal: cancel.signal, request, t, changed });
        } else if (tab === "legacy-details") {
          const { entries } = await request<MemoryLegacySessionView>(url, "GET", undefined, cancel.signal);
          if (!cancel.signal.aborted) renderLegacyRecords(body, entries, t);
        } else if (tab === "settings") {
          const settings = await request<MemorySessionPolicy>(url + "/memory-policy", "GET", undefined, cancel.signal);
          if (!cancel.signal.aborted) renderSettings(settings);
        } else {
          const detail = await request<MemorySessionDetail>(url + "/memory", "GET", undefined, cancel.signal);
          if (!cancel.signal.aborted) renderDetails(detail);
        }
        if (!cancel.signal.aborted) status.textContent = "";
      } catch (error) {
        showError(error);
        loadRetry.hidden = false;
      }
    }
    dialog.querySelector<HTMLButtonElement>("[data-close-memory]")!.onclick = () => dialog.close();
    dialog.addEventListener(
      "close",
      () => {
        cancel.abort();
        dialog.remove();
        if (active === dialog) {
          active = undefined;
          if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }
      },
      { once: true },
    );
    active = dialog;
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLElement>("h2")?.focus();
    void load();
  }
  return { close, show };
}
