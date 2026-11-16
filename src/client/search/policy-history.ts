import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type {
  SearchSettings,
  PreviousSearchSettingsPage,
  ProjectSearchPolicySummary,
} from "../../shared/search/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { searchRequest } from "./api.js";
import { searchContentKinds } from "../../shared/search/validation.js";

function policyRulesHtml(settings: SearchSettings, t: Translate) {
  const rows: [MessageId, string][] = [
    [
      "search.contentKinds",
      searchContentKinds(settings.contentKinds)
        .map((kind) => t(`creative.${kind}`))
        .join(", "),
    ],
    ["search.indexSavedContent", t(settings.enabled ? "search.enabled" : "search.disabled")],
    ["search.indexFulltext", t(settings.fulltext ? "search.enabled" : "search.disabled")],
    ["search.indexVector", t(settings.vector ? "search.enabled" : "search.disabled")],
    ["search.includePaths", settings.include.join("\n") || t("search.knowledgeProject")],
    ["search.excludePaths", settings.exclude.join("\n") || t("search.none")],
  ];
  if (settings.vector) rows.push(["search.knowledgeRange", JSON.stringify(settings.knowledge, null, 2)]);
  return `<details><summary>${e(t("search.inspectPolicy"))}</summary><dl class="search-policy-rules">${rows.map(([key, value]) => `<div><dt>${e(t(key))}</dt><dd data-i18n-ignore>${e(value)}</dd></div>`).join("")}</dl></details>`;
}

export function searchPolicyHistoryHtml(t: Translate) {
  return `<p data-project-policy-status role="status" hidden></p><details data-project-policy-history hidden><summary>${e(t("search.previousSettings"))}</summary><p>${e(t("search.previousSettingsHint"))}</p><p data-policy-notice role="status"></p><div class="search-profile-list" data-policy-items></div><div class="resource-actions"><button class="wb-button" type="button" data-policy-previous hidden>${e(t("search.previousPolicyPage"))}</button><button class="wb-button" type="button" data-policy-next hidden>${e(t("search.nextPolicyPage"))}</button></div></details>`;
}

/** Historical settings only fill a local draft. Scope changes and closing the page cancel all retained requests. */
export function bindSearchPolicyHistory(
  host: HTMLElement,
  t: Translate,
  options: {
    signal: AbortSignal;
    scope(): { project: string; source: string };
    choose(settings: SearchSettings): void;
  },
) {
  const get = <T extends HTMLElement>(q: string) => host.querySelector<T>(q)!,
    details = get<HTMLDetailsElement>("[data-project-policy-history]"),
    notice = get("[data-policy-notice]"),
    previous = get<HTMLButtonElement>("[data-policy-previous]"),
    next = get<HTMLButtonElement>("[data-policy-next]");
  let closed = false,
    controller: AbortController | null = null,
    page: PreviousSearchSettingsPage | null = null,
    offset = 0,
    generation = 0,
    pending = false;
  async function load(at: number) {
    if (closed || options.signal.aborted) return;
    controller?.abort();
    const local = (controller = new AbortController()),
      read = ++generation,
      scope = options.scope();
    pending = true;
    notice.textContent = t("search.loading");
    previous.disabled = next.disabled = true;
    try {
      const result = await searchRequest<PreviousSearchSettingsPage>(
        "/previous-settings?" + new URLSearchParams({ ...scope, offset: String(at) }),
        "GET",
        undefined,
        AbortSignal.any([options.signal, local.signal]),
      );
      if (local.signal.aborted || options.signal.aborted || read !== generation) return;
      page = result;
      offset = at;
      setMessageHtml(
        get("[data-policy-items]"),
        result.items
          .map(
            (item, index) =>
              `<article><strong>${e(t("search.previousPolicyVersion", { revision: item.revision }))}</strong><span data-i18n-ignore>${e(t("search.previousPolicyOwner", { owner: item.owner }))}</span><small>${e(new Date(item.updatedAt).toLocaleString(document.documentElement.lang || "en"))}</small>${item.settings ? `<span data-i18n-ignore>${e(item.settings.analyzer)} · ${e(t("search.previousPolicyPaths", { included: item.settings.include.length, excluded: item.settings.exclude.length }))}</span>${policyRulesHtml(item.settings, t)}` : `<p>${e(t("search.previousUnavailable"))}</p>`}<div class="resource-actions"><button class="wb-button" type="button" data-policy-choice="${index}" ${item.settings ? "" : "disabled"}>${e(t("search.loadPrevious"))}</button></div></article>`,
          )
          .join(""),
      );
      previous.hidden = offset === 0;
      next.hidden = result.nextOffset === null;
      notice.textContent = "";
    } catch {
      if (!local.signal.aborted && !options.signal.aborted && read === generation)
        notice.textContent = t("search.unavailable");
    } finally {
      if (read === generation) {
        pending = false;
        previous.disabled = next.disabled = false;
      }
    }
  }
  get("[data-policy-items]").onclick = (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-policy-choice]");
    if (!target || closed || pending || !page || options.signal.aborted) return;
    const settings = page.items[Number(target.dataset.policyChoice)]?.settings;
    if (!settings) return;
    options.choose(structuredClone(settings));
    notice.textContent = t("search.policyDraftLoaded");
  };
  details.ontoggle = () => {
    if (details.open && !page && !pending) void load(0);
  };
  previous.onclick = () => void load(Math.max(0, offset - 4));
  next.onclick = () => {
    if (page?.nextOffset !== null && page?.nextOffset !== undefined) void load(page.nextOffset);
  };
  return {
    update(policy: ProjectSearchPolicySummary | null | undefined) {
      const status = get("[data-project-policy-status]");
      status.hidden = !policy;
      status.textContent = policy ? t(policy.needsReview ? "search.policyNeedsReview" : "search.projectShared") : "";
      details.hidden = !policy?.previous;
    },
    reset() {
      controller?.abort();
      generation++;
      page = null;
      pending = false;
      offset = 0;
      details.open = false;
      details.hidden = true;
      get("[data-policy-items]").replaceChildren();
      get("[data-project-policy-status]").hidden = true;
      notice.textContent = "";
      previous.hidden = next.hidden = true;
    },
    close() {
      closed = true;
      controller?.abort();
      generation++;
      details.ontoggle = null;
    },
  };
}
