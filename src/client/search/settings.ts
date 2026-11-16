import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import {
  searchRequest,
  searchProjects,
  SearchRequestError,
  type SearchCatalog,
  type SearchStatus,
  type SearchResults,
  type AnalyzerReview,
} from "./api.js";
import { searchSettingsHtml } from "./settings-view.js";
import { searchResultsHtml, searchStateLabel } from "./results.js";
import { searchAuditHtml } from "./audit-view.js";
import { searchProgressHtml } from "./progress-view.js";
import type { AnalyzerPackage } from "../../shared/search/contracts.js";
import { searchValue as value, searchChecked as checked } from "./form-fields.js";
import { bindSearchConfiguration } from "./configuration.js";
import { bindSearchIndexSelection, type SearchScopePreview } from "./index-selection.js";
import { bindSearchPolicyHistory } from "./policy-history.js";
import { fillSearchContentKinds, readSearchContentKinds } from "./content-kinds.js";
import { bindVectorStorage } from "./vector-storage.js";
const errorKeys = {
  invalidInput: "search.invalidInput",
  unavailable: "search.unavailable",
  conflict: "search.conflict",
  notFound: "search.notFound",
  limit: "search.limit",
  configuration: "search.configuration",
  indexChanged: "search.indexChanged",
  forbidden: "search.forbidden",
  notReady: "search.notReady",
} as const;
export function createSearchSettings(t: Translate) {
  let host: HTMLElement | null = null,
    epoch = 0,
    scopeEpoch = 0,
    selectionEpoch = 0,
    formDirty = false,
    formRevision: number | null = null,
    formSettings: SearchStatus["settings"] | null = null,
    busy = false,
    closing = new AbortController(),
    scopeRead: AbortController | null = null,
    poll: ReturnType<typeof setTimeout> | undefined;
  let catalog: SearchCatalog,
    projects: { id: string; name: string }[] = [],
    status: SearchStatus | null = null,
    selection: ReturnType<typeof bindSearchIndexSelection> | null = null,
    policyHistory: ReturnType<typeof bindSearchPolicyHistory> | null = null,
    vectorStorage: ReturnType<typeof bindVectorStorage> | null = null,
    review: AnalyzerReview | null = null;
  const get = <T extends HTMLElement>(q: string) => host!.querySelector<T>(q)!,
    notice = (message: string) => {
      if (host) get("[data-search-notice]").textContent = message;
    };
  const api = <T>(path: string, method = "GET", body?: unknown) => searchRequest<T>(path, method, body, closing.signal);
  const scope = () => ({
    project: get<HTMLSelectElement>("[data-scope-project]").value,
    source: get<HTMLSelectElement>("[data-scope-source]").value,
  });
  async function run(work: () => Promise<void>) {
    if (!host || busy) return;
    busy = true;
    const generation = epoch;
    notice(t("search.working"));
    host.setAttribute("aria-busy", "true");
    try {
      await work();
      if (host && generation === epoch) {
        const current = get("[data-search-notice]").textContent;
        if (!current || current === t("search.working")) notice(t("search.saved"));
      }
    } catch (error) {
      if (host && generation === epoch && !closing.signal.aborted)
        notice(
          t(
            error instanceof SearchRequestError
              ? (errorKeys[error.code as keyof typeof errorKeys] ?? "search.unavailable")
              : "search.unavailable",
          ),
        );
    } finally {
      if (host && generation === epoch) {
        busy = false;
        host.removeAttribute("aria-busy");
      }
    }
  }
  function fillIndexForm(settings: SearchStatus["settings"]) {
    const form = get<HTMLFormElement>("[data-index-form]");
    formSettings = structuredClone(settings);
    selection?.fill(settings);
    fillSearchContentKinds(form, settings);
    (form.elements.namedItem("pf-search-enabled") as HTMLInputElement).checked = settings.enabled;
    (form.elements.namedItem("pf-search-analyzer") as HTMLSelectElement).value = settings.analyzer;
    (form.elements.namedItem("pf-search-include") as HTMLTextAreaElement).value = settings.include.join("\n");
    (form.elements.namedItem("pf-search-exclude") as HTMLTextAreaElement).value = settings.exclude.join("\n");
  }
  async function readScope(attempt = 0) {
    clearTimeout(poll);
    scopeRead?.abort();
    scopeRead = new AbortController();
    const local = scopeRead,
      read = ++scopeEpoch,
      generation = epoch,
      s = scope();
    if (attempt === 0) {
      selectionEpoch++;
      status = null;
      formDirty = false;
      formRevision = null;
      formSettings = null;
      selection?.reset();
      policyHistory?.reset();
      get<HTMLFieldSetElement>("[data-index-form] fieldset").disabled = true;
      get("[data-scope-status]").textContent = t("search.loading");
      get("[data-index-audit-report]").replaceChildren();
      get("[data-index-progress]").replaceChildren();
      get<HTMLButtonElement>("[data-index-audit]").disabled = true;
      get("[data-test-results]").replaceChildren();
      get("[data-index-preview-results]").replaceChildren();
    }
    try {
      const next = await searchRequest<SearchStatus>(
        "/status?" + new URLSearchParams(s),
        "GET",
        undefined,
        AbortSignal.any([closing.signal, local.signal]),
      );
      if (!host || epoch !== generation || read !== scopeEpoch) return;
      status = next;
      if (!formDirty) {
        formRevision = next.revision;
        fillIndexForm(next.settings);
      }
      policyHistory?.update(next.projectPolicy);
      get<HTMLFieldSetElement>("[data-index-form] fieldset").disabled = false;
      get("[data-scope-status]").textContent =
        searchStateLabel(next.state, t) +
        (next.settings.fulltext ? " · " + t("search.documentCount", { count: next.documentCount }) : "");
      const usage = get("[data-embedding-usage]");
      usage.hidden = !next.embedding;
      usage.textContent = next.embedding
        ? t("search.embeddingUsage", {
            ...next.embedding,
            reset: new Date(next.embedding.resetsAt).toLocaleString(document.documentElement.lang || "en"),
          }) +
          " " +
          t("search.embeddingUsageHint")
        : "";
      setMessageHtml(get("[data-index-audit-report]"), searchAuditHtml(next, t, document.documentElement.lang || "en"));
      setMessageHtml(get("[data-index-progress]"), searchProgressHtml(next, t, document.documentElement.lang || "en"));
      get<HTMLButtonElement>("[data-index-rebuild]").disabled =
        !next.settings.enabled || ["queued", "running"].includes(next.state);
      get<HTMLButtonElement>("[data-index-audit]").disabled =
        !next.settings.enabled || !!next.audit?.running || ["queued", "running"].includes(next.state);
      if (["queued", "running"].includes(next.state) || next.audit?.running || next.audit?.queued)
        poll = setTimeout(() => void readScope(attempt + 1), attempt < 30 ? 1000 : 5000);
    } catch (error) {
      if (host && epoch === generation && read === scopeEpoch && !local.signal.aborted)
        get("[data-scope-status]").textContent = t("search.unavailable");
    }
  }
  async function reload() {
    const generation = epoch,
      next = await api<SearchCatalog>("/catalog");
    if (!host || generation !== epoch) return;
    catalog = next;
    render();
  }
  const formSubmit = (selector: string, work: (form: HTMLFormElement) => Promise<void>) => {
    get<HTMLFormElement>(selector).onsubmit = (event) => {
      event.preventDefault();
      void run(() => work(event.currentTarget as HTMLFormElement));
    };
  };
  const download = (descriptor: AnalyzerPackage) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(descriptor, null, 2)], { type: "application/json" })),
      a = document.createElement("a");
    a.href = url;
    a.download = descriptor.id + "-" + descriptor.version + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function showReview() {
    const target = get("[data-analyzer-review]");
    if (!review) {
      target.replaceChildren();
      return;
    }
    setMessageHtml(
      target,
      `<article class="publish-object"><h3>${e(t("search.reviewPack"))}</h3><p>${e(t("search.recipeHint"))}</p><pre data-i18n-ignore>${e(JSON.stringify(review.origin, null, 2))}</pre>${review.packages.map((p) => `<p data-i18n-ignore><strong>${e(p.name)}</strong> · ${e(p.id)}@${e(p.version)} · ${e(p.languages.join(", "))}</p>`).join("")}<button class="wb-button" type="button" data-analyzer-install>${e(t("search.installPack"))}</button></article>`,
    );
    get<HTMLButtonElement>("[data-analyzer-install]").onclick = () =>
      void run(async () => {
        await api("/analyzers/install", "POST", { digest: review!.digest });
        review = null;
        await reload();
      });
  }
  function render() {
    if (!host) return;
    vectorStorage?.close();
    vectorStorage = null;
    const locationScope = new URL(location.href).searchParams,
      previousProject =
        host.querySelector<HTMLSelectElement>("[data-scope-project]")?.value ?? locationScope.get("indexProject"),
      previousSource =
        host.querySelector<HTMLSelectElement>("[data-scope-source]")?.value ?? locationScope.get("indexSource"),
      connectionsOpen = host.querySelector<HTMLDetailsElement>(".search-connections")?.open ?? false;
    scopeRead?.abort();
    policyHistory?.close();
    policyHistory = null;
    clearTimeout(poll);
    setMessageHtml(host, searchSettingsHtml(catalog, projects, t));
    if (!catalog.administrator) return;
    if (
      previousProject &&
      [...get<HTMLSelectElement>("[data-scope-project]").options].some((o) => o.value === previousProject)
    )
      get<HTMLSelectElement>("[data-scope-project]").value = previousProject;
    if (
      previousSource &&
      [...get<HTMLSelectElement>("[data-scope-source]").options].some((o) => o.value === previousSource)
    )
      get<HTMLSelectElement>("[data-scope-source]").value = previousSource;
    get<HTMLFormElement>("[data-index-form]").oninput = () => {
      formDirty = true;
    };
    get<HTMLDetailsElement>(".search-connections").open = connectionsOpen;
    bindSearchConfiguration(host, catalog, t, { api, run, reload, notice });
    vectorStorage = bindVectorStorage(host, t, closing.signal);
    selection = bindSearchIndexSelection(host, t, () => {
      formDirty = true;
    });
    policyHistory = bindSearchPolicyHistory(host, t, {
      signal: closing.signal,
      scope,
      choose(settings) {
        fillIndexForm(settings);
        formDirty = true;
        notice(t("search.policyDraftLoaded"));
      },
    });
    get<HTMLButtonElement>("[data-index-pick]").onclick = () =>
      void run(async () => {
        const selected = selectionEpoch;
        const result = await api<SearchScopePreview>("/preview", "POST", scope());
        if (host && selected === selectionEpoch) selection?.show(result);
      });
    for (const key of ["source", "project"])
      get<HTMLSelectElement>("[data-scope-" + key + "]").onchange = () => {
        const url = new URL(location.href),
          selected = scope();
        url.searchParams.set("indexProject", selected.project);
        url.searchParams.set("indexSource", selected.source);
        history.replaceState(history.state, "", url);
        void readScope();
      };
    formSubmit("[data-index-form]", async (form) => {
      if (!status || formRevision === null || !formSettings) throw new SearchRequestError("conflict");
      await api("/settings", "PUT", {
        ...scope(),
        revision: formRevision,
        settings: {
          ...formSettings,
          ...readSearchContentKinds(form, formSettings),
          enabled: checked(form, "enabled"),
          fulltext: checked(form, "fulltext"),
          vector: checked(form, "vector"),
          knowledge: selection!.read(),
          analyzer: value(form, "analyzer"),
          include: value(form, "include")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          exclude: value(form, "exclude")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      await readScope();
    });
    get<HTMLButtonElement>("[data-index-rebuild]").onclick = () =>
      void run(async () => {
        await api("/rebuild", "POST", scope());
        await readScope();
      });
    get<HTMLButtonElement>("[data-index-audit]").onclick = () =>
      void run(async () => {
        const selected = selectionEpoch;
        await api("/audit", "POST", scope());
        if (host && selected === selectionEpoch) await readScope(1);
      });
    get<HTMLButtonElement>("[data-index-preview]").onclick = () =>
      void run(async () => {
        const selected = selectionEpoch;
        const result = await api<{
          total: number;
          truncated: boolean;
          documents: { id: string; title: string; path: string; selected: boolean }[];
        }>("/preview", "POST", scope());
        if (!host || selected !== selectionEpoch) return;
        setMessageHtml(
          get("[data-index-preview-results]"),
          `<p>${e(t("search.documentCount", { count: result.total }))}${result.truncated ? " · " + e(t("search.previewLimited")) : ""}</p><ul class="search-scope-preview">${result.documents.map((d) => `<li><strong data-i18n-ignore>${e(d.title)}</strong><span data-i18n-ignore>${e(d.path)}</span><small>${e(t(d.selected ? "search.included" : "search.excluded"))}</small></li>`).join("")}</ul>`,
        );
      });
    get<HTMLSelectElement>("[data-search-mode]").onchange = () => {
      selectionEpoch++;
      get("[data-test-results]").replaceChildren();
      get("[data-search-mode-hint]").hidden = get<HTMLSelectElement>("[data-search-mode]").value === "text";
    };
    formSubmit("[data-test-form]", async (form) => {
      const selected = selectionEpoch;
      const result = await api<SearchResults>("/test", "POST", {
        ...scope(),
        query: value(form, "query"),
        mode: value(form, "mode"),
      });
      if (!host || selected !== selectionEpoch) return;
      setMessageHtml(get("[data-test-results]"), searchResultsHtml(result, t));
      notice(result.failure ? t("search.indexFailed") : searchStateLabel(result.state, t));
      await readScope(1);
    });
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-analyzer-export]"))
      button.onclick = () =>
        void run(async () =>
          download(
            await api<AnalyzerPackage>(
              "/analyzers/export?" + new URLSearchParams({ reference: button.dataset.analyzerExport! }),
            ),
          ),
        );
    get<HTMLInputElement>("[data-analyzer-file]").onchange = (event) =>
      void run(async () => {
        const file = (event.currentTarget as HTMLInputElement).files?.[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) throw new SearchRequestError("limit");
        let content: unknown, kind: string;
        if (file.name.toLowerCase().endsWith(".zip")) {
          kind = "zip";
          content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
        } else {
          kind = "json";
          content = JSON.parse(await file.text());
        }
        review = await api<AnalyzerReview>("/analyzers/review", "POST", { kind, name: file.name, content });
        showReview();
      });
    formSubmit("[data-analyzer-github]", async (form) => {
      review = await api<AnalyzerReview>("/analyzers/review", "POST", {
        kind: "github",
        repository: value(form, "repository"),
        ...(value(form, "ref") ? { ref: value(form, "ref") } : {}),
        root: value(form, "root"),
      });
      showReview();
    });
    void readScope();
  }
  return {
    show(target: HTMLElement) {
      vectorStorage?.close();
      vectorStorage = null;
      scopeRead?.abort();
      policyHistory?.close();
      policyHistory = null;
      clearTimeout(poll);
      scopeEpoch++;
      selectionEpoch++;
      busy = false;
      host = target;
      host.classList.add("search-settings", "wb-form");
      epoch++;
      closing.abort();
      closing = new AbortController();
      setMessageHtml(
        host,
        `<header class="resource-heading"><h1>${e(t("search.settingsTitle"))}</h1></header><p data-search-notice role="status">${e(t("search.loading"))}</p>`,
      );
      const generation = epoch;
      void Promise.all([api<SearchCatalog>("/catalog"), searchProjects(closing.signal)])
        .then(([c, p]) => {
          if (!host || generation !== epoch) return;
          catalog = c;
          projects = p;
          render();
        })
        .catch(() => {
          if (host && generation === epoch) notice(t("search.unavailable"));
        });
    },
    hide() {
      vectorStorage?.close();
      vectorStorage = null;
      epoch++;
      scopeEpoch++;
      selectionEpoch++;
      closing.abort();
      scopeRead?.abort();
      clearTimeout(poll);
      const secret = host?.querySelector<HTMLInputElement>('[data-connection-form] [name="pf-search-secret"]');
      if (secret) secret.value = "";
      policyHistory?.close();
      policyHistory = null;
      host = null;
      selection = null;
      review = null;
      busy = false;
    },
  };
}
