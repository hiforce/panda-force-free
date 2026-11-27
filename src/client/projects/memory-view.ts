import { isProjectMemoryScope } from "../../shared/project-memory/contracts.js";
import { memoryDisplayName } from "../../shared/project-memory/language.js";
import { mountProjectTeamMemory } from "./memory-team.js";
import { memoryMaterialLocationLabel } from "./memory-package-materials.js";
import type { MemoryMaterialSearchPage } from "../../shared/project-memory/materials.js";
import type { MessageId, MessageParameters, Translate } from "../../shared/i18n/messages.js";
import type {
  MemoryDetail,
  MemoryEntry,
  MemoryIndexStatus,
  MemoryTransition,
  MemoryVersion,
} from "../../shared/project-memory/contracts.js";
import { escapeHtml as escape } from "../../shared/html.js";
import { memoryBrowse, memorySourceHref, rememberMemoryBrowse, type MemoryView } from "./memory-source-link.js";
import { createMemoryPackages, memoryPackageSources } from "./memory-packages.js";
import { createMemoryTerrainView } from "./memory-terrain-view.js";
import { codexIcon } from "../codex-icons.js";
import { harnessApi } from "../harness/api.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { projectOverviewHeading } from "../creative/project-view.js";
import type { ContentProject } from "../creative/contracts.js";

const historyLabels: Record<MemoryTransition, keyof MessageParameters> = {
  recorded: "projects.memoryHistoryRecorded",
  corroborated: "projects.memoryHistoryCorroborated",
  conflict: "projects.memoryHistoryConflict",
  replaced: "projects.memoryHistoryReplaced",
  recovered: "projects.memoryHistoryRecovered",
  sourceWithdrawn: "projects.memoryHistorySourceWithdrawn",
  withdrawn: "projects.memoryHistoryWithdrawn",
};

export function createProjectMemoryView(t: Translate, projects: () => ContentProject[]) {
  const request = harnessApi(t);
  const packages = createMemoryPackages(t);
  let section: HTMLElement | undefined;
  let terrain: ReturnType<typeof createMemoryTerrainView> | undefined;
  const historyRequests = new Map<HTMLDetailsElement, AbortController>();
  let controller: AbortController | undefined;
  let teamLifecycle: AbortController | undefined;
  let team: ReturnType<typeof mountProjectTeamMemory> | undefined;
  let project = "";
  let entries: MemoryEntry[] = [];
  let materials: MemoryMaterialSearchPage | undefined;
  let search = "";
  let rebuilding = false;
  let offset: number | null = null;
  const m = (id: Extract<keyof MessageParameters, `projects.memory${string}`> | "common.save" | "common.retry") =>
    messageHtml(id, {}, t);
  const toolbarButton = (label: MessageId, icon: string, state: string) =>
    `<button type="button" class="wb-button memory-toolbar-button" ${state}
        ${messageAttributes("aria-label", label, {}, t)} ${messageAttributes("data-tooltip", label, {}, t)}>
        ${codexIcon(icon)}<span class="memory-toolbar-label">${messageHtml(label, {}, t)}</span></button>`;
  const path = () => "/api/projects/" + encodeURIComponent(project) + "/";
  const status = () => section?.querySelector<HTMLElement>("[data-memory-status]");
  function sourceList(entry: MemoryEntry) {
    return `<ul>${entry.sources
      .map(
        (source) =>
          `<li><a href="${escape(memorySourceHref(project, source, { mode: "records" }))}">${m("projects.memorySourcePosition")}</a></li>`,
      )
      .join(
        "",
      )}${memoryPackageSources(t, entry.packages, entry)}${entry.manual?.length ? `<li>${m("projects.memoryManualSource")}</li>` : ""}</ul>`;
  }
  function historyMarkup(versions: MemoryVersion[]) {
    const dates = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" });
    return versions
      .filter(({ reason, entry }) => reason !== "conflict" && entry?.state !== "conflict")
      .map(
        ({ changedAt, reason, entry }) =>
          `<li class="project-memory-version"><div><strong>${messageHtml(historyLabels[reason], {}, t)}</strong>
       <time datetime="${new Date(changedAt).toISOString()}">${escape(dates.format(changedAt))}</time></div>
       ${entry?.value ? `<code data-i18n-ignore>${escape(entry.value)}</code>` : ""}
       ${entry && (entry.sources.length || entry.packages?.length || entry.manual?.length) ? sourceList(entry) : ""}</li>`,
      )
      .join("");
  }
  async function loadHistory(details: HTMLDetailsElement, before?: number) {
    const timeline = details.querySelector<HTMLOListElement>("[data-memory-versions]")!;
    const historyStatus = details.querySelector<HTMLElement>("[data-memory-history-status]")!;
    const button = details.querySelector<HTMLButtonElement>("button")!;
    historyRequests.get(details)?.abort();
    const requestState = new AbortController();
    historyRequests.set(details, requestState);
    button.hidden = true;
    historyStatus.textContent = t("common.pageLoading");
    try {
      const data = await request<MemoryDetail>(
        path() + "memory/" + details.dataset.memoryHistory + (before === undefined ? "" : "?before=" + before),
        "GET",
        undefined,
        requestState.signal,
      );
      if (requestState.signal.aborted || !details.isConnected || !details.open) return;
      if (before === undefined) setMessageHtml(timeline, "");
      const nextItems = document.createElement("ol");
      setMessageHtml(nextItems, historyMarkup(data.versions));
      timeline.append(...Array.from(nextItems.children));
      historyStatus.textContent = timeline.childElementCount ? "" : t("projects.memoryHistoryEmpty");
      button.hidden = data.next === null;
      if (data.next !== null) {
        setMessageHtml(button, m("projects.memoryOlder"));
        button.onclick = () => void loadHistory(details, data.next!);
      }
    } catch (error) {
      if (requestState.signal.aborted || !details.isConnected || !details.open) return;
      if (error && typeof error === "object" && "code" in error && error.code === "notFound") {
        if (section) void load();
      } else {
        historyStatus.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
        setMessageHtml(button, m("common.retry"));
        button.hidden = false;
        button.onclick = () => void loadHistory(details, before);
      }
    } finally {
      if (historyRequests.get(details) === requestState) historyRequests.delete(details);
    }
  }
  function renderEntries() {
    const list = section?.querySelector<HTMLElement>("[data-memory-entries]");
    if (!list) return;
    const openHistory = new Set(
      [...list.querySelectorAll<HTMLDetailsElement>("[data-memory-history][open]")].map(
        (detail) => detail.dataset.memoryHistory,
      ),
    );
    const openSources = new Set(
      [...list.querySelectorAll<HTMLDetailsElement>("[data-memory-sources][open]")].map(
        (detail) => detail.dataset.memorySources,
      ),
    );
    for (const current of historyRequests.values()) current.abort();
    historyRequests.clear();
    setMessageHtml(
      list,
      entries
        .filter(({ state }) => state !== "conflict")
        .map(
          (entry) =>
            `<article class="project-memory-entry"><header><h3 data-i18n-ignore>${escape(entry.title ?? memoryDisplayName(entry.key))}</h3>${isProjectMemoryScope(entry.scope) ? "" : `<span data-i18n-ignore>${escape(entry.scope)}</span>`}</header>
      <p>${entry.value === null ? m("projects.memoryHistoryWithdrawn") : `<code data-i18n-ignore>${escape(entry.value)}</code>`}</p>
      ${
        entry.state === "active" && entry.sources.length
          ? `<button type="button" class="wb-button memory-team-action" data-memory-team-publish="${escape(entry.id)}"
        ${messageAttributes("aria-label", "projects.memoryTeamPreview", {}, t)} ${messageAttributes("data-tooltip", "projects.memoryTeamPreview", {}, t)}>
        ${codexIcon("arrowUpRight")}<span class="memory-team-action-label">${m("projects.memoryTeamPreview")}</span></button>`
          : ""
      }
      ${entry.sources.length || entry.packages?.length || entry.manual?.length ? `<details data-memory-sources="${escape(entry.id)}"${openSources.has(entry.id) ? " open" : ""}><summary>${m("projects.memorySources")}</summary>${sourceList(entry)}</details>` : ""}
      <details data-memory-history="${escape(entry.id)}"><summary>${m("projects.memoryHistory")}</summary>
        <p data-memory-history-status role="status"></p><ol data-memory-versions></ol>
        <button class="wb-button" type="button" hidden>${m("projects.memoryOlder")}</button>
      </details></article>`,
        )
        .join("") ||
        (materials?.hits.length
          ? ""
          : `<p>${m(search ? "projects.memorySearchEmpty" : "projects.memoryPersonalEmpty")}</p>`),
    );
    for (const details of list.querySelectorAll<HTMLDetailsElement>("[data-memory-history]")) {
      details.ontoggle = () => {
        if (details.open) void loadHistory(details);
        else {
          historyRequests.get(details)?.abort();
          setMessageHtml(details.querySelector<HTMLOListElement>("[data-memory-versions]")!, "");
        }
      };
      if (openHistory.has(details.dataset.memoryHistory)) details.open = true;
    }
    section!.querySelector<HTMLButtonElement>("[data-memory-more]")!.hidden = offset === null;
  }
  function renderMaterials() {
    const panel = section?.querySelector<HTMLElement>("[data-memory-materials]");
    if (!panel) return;
    panel.hidden = !materials;
    if (!materials) return setMessageHtml(panel, "");
    const state =
      materials.state === "pending"
        ? "projects.memoryMaterialIndexing"
        : materials.state === "unavailable"
          ? "projects.memoryMaterialIndexUnavailable"
          : null;
    setMessageHtml(
      panel,
      `<h3>${m("projects.memoryMaterialTitle")}</h3>
      ${
        state
          ? `<div class="memory-material-progress"><p role="status">${m(state)}</p>${toolbarButton(
              materials.state === "pending" ? "projects.memorySearchRefresh" : "common.retry",
              "refreshCw",
              "data-material-search-refresh",
            )}</div>`
          : ""
      }
      ${
        materials.hits.length
          ? `<ul>${materials.hits
              .map(
                (hit, index) => `<li>
        <button type="button" class="memory-material-link" data-material-search-result="${index}" aria-haspopup="dialog" data-i18n-ignore>${escape(hit.material.title)}</button>
        <small><span data-i18n-ignore>${escape(hit.file.name)}</span>${
          hit.location ? ` · ${escape(memoryMaterialLocationLabel(t, hit.location))}` : ""
        }</small>
        ${hit.excerpt ? `<p>${hit.recognition === "ocr" ? `<small>${m("projects.memoryMaterialRecognizedText")}</small> ` : ""}<span data-i18n-ignore>${escape(hit.excerpt)}</span></p>` : ""}
      </li>`,
              )
              .join("")}</ul>`
          : state
            ? ""
            : `<p>${m("projects.memoryMaterialSearchEmpty")}</p>`
      }`,
    );
  }
  function renderIndex(index: MemoryIndexStatus | undefined) {
    const toggle = section!.querySelector<HTMLDetailsElement>("[data-memory-index]")!;
    toggle.hidden = !index;
    if (!index) return;
    const headline = toggle.querySelector<HTMLElement>("[data-memory-index-state]")!;
    const detail = toggle.querySelector<HTMLElement>("[data-memory-index-cleanup]")!;
    const label = index.fallback
      ? "projects.memorySearchLocalFallback"
      : index.state === "pending"
        ? "projects.memorySearchPending"
        : index.state === "unavailable"
          ? "projects.memorySearchUnavailable"
          : index.backend === "local"
            ? "projects.memorySearchLocal"
            : "projects.memorySearchElastic";
    setMessageHtml(headline, m(label));
    detail.hidden = !index.cleanupPending;
  }
  async function rebuildIndex(button: HTMLButtonElement) {
    if (!section || rebuilding) return;
    const active = section;
    rebuilding = button.disabled = true;
    try {
      const index = await request<MemoryIndexStatus>(path() + "memory-index", "POST", {});
      if (active === section) renderIndex(index);
    } catch (error) {
      if (active === section)
        status()!.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      if (active === section) {
        rebuilding = false;
        button.disabled = false;
      }
    }
  }
  async function load(append = false) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const info = status()!;
    const retry = section!.querySelector<HTMLButtonElement>("[data-memory-retry]")!;
    info.textContent = t("common.pageLoading");
    retry.hidden = true;
    if (!append && !section?.querySelector<HTMLElement>("[data-memory-records]")?.hidden) void team?.refresh(search);
    try {
      const params = new URLSearchParams({
        offset: String(append ? (offset ?? 0) : 0),
        ...(search ? { q: search } : {}),
      });
      const page = await request<{
        entries: MemoryEntry[];
        next: number | null;
        index?: MemoryIndexStatus;
        materials?: MemoryMaterialSearchPage;
      }>(path() + "memory?" + params, "GET", undefined, current.signal);
      if (current.signal.aborted) return;
      entries = append ? [...entries, ...page.entries] : page.entries;
      offset = page.next;
      if (!append) {
        materials = page.materials;
        renderMaterials();
      }
      renderEntries();
      renderIndex(page.index);
      info.textContent = "";
    } catch (error) {
      if (current.signal.aborted) return;
      info.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      retry.hidden = false;
    }
  }
  return {
    show(host: HTMLElement, id = "") {
      if (section?.parentElement === host && project === id) return;
      controller?.abort();
      teamLifecycle?.abort();
      terrain?.hide();
      project = id;
      entries = [];
      search = "";
      rebuilding = false;
      offset = null;
      const member =
        (globalThis as typeof globalThis & { __pandaForceIdentity?: { role?: string } }).__pandaForceIdentity?.role ===
        "member";
      if (member) {
        setMessageHtml(
          host,
          `<section class="project-overview project-memory-view">${projectOverviewHeading(
            t,
            id,
            projects().find((item) => item.id === id),
            "",
            "memory",
          )}<section class="project-team-memory" data-memory-team></section></section>`,
        );
        section = host.querySelector<HTMLElement>(".project-memory-view")!;
        teamLifecycle = new AbortController();
        team = mountProjectTeamMemory(
          section.querySelector<HTMLElement>("[data-memory-team]")!,
          section,
          id,
          t,
          request,
          teamLifecycle.signal,
        );
        void team.refresh();
        return;
      }
      setMessageHtml(
        host,
        `<section class="project-overview project-memory-view">${projectOverviewHeading(
          t,
          id,
          projects().find((item) => item.id === id),
          "",
          "memory",
        )}
        <header class="project-section-heading project-memory-header"><h2>${m("projects.memory")}</h2>
        <div class="memory-toolbar" role="group" ${messageAttributes("aria-label", "projects.memory", {}, t)}>
          <div class="memory-toolbar-group">
            ${toolbarButton("projects.memoryTerrain", "compass", 'data-memory-mode="terrain" aria-pressed="true"')}
            ${toolbarButton("projects.memoryTerrainEvidence", "gitBranch", 'data-memory-mode="evidence" aria-pressed="false"')}
            ${toolbarButton("projects.memoryTerrainRecords", "list", 'data-memory-mode="records" aria-pressed="false"')}
          </div>
          <div class="memory-toolbar-group">
            <a class="wb-button memory-toolbar-button" href="/settings/memory-settings?project=${encodeURIComponent(project)}"
              ${messageAttributes("aria-label", "projects.memorySettings", {}, t)}
              ${messageAttributes("data-tooltip", "projects.memorySettings", {}, t)}>
              ${codexIcon("slidersHorizontal")}<span class="memory-toolbar-label">${m("projects.memorySettings")}</span></a>
          </div>
        </div></header>
        <div data-memory-terrain></div>
        <div data-memory-records hidden>
        <div class="project-memory-search">
          <div class="memory-package-buttons">
            ${toolbarButton("projects.memoryPackageImportTitle", "arrowUp", 'data-memory-packages-import aria-haspopup="dialog"')}
            ${toolbarButton("projects.memoryPackageExportTitle", "download", 'data-memory-packages-export aria-haspopup="dialog"')}
          </div>
          <form role="search" class="wb-form" data-memory-search>
            <label class="wb-field"><span class="sr-only">${m("projects.memorySearch")}</span>
            <input type="search" maxlength="160" ${messageAttributes("placeholder", "projects.memorySearch", {}, t)}></label>
            <button class="wb-button" type="submit">${m("projects.memorySearchSubmit")}</button>
          </form>
          <details data-memory-index hidden><summary data-memory-index-state></summary>
            <p class="wb-help" data-memory-index-cleanup hidden>${m("projects.memorySearchCleanup")}</p>
            <div><button class="wb-button" type="button" data-memory-index-refresh>${m("projects.memorySearchRefresh")}</button>
            <button class="wb-button" type="button" data-memory-index-rebuild>${m("projects.memorySearchRebuild")}</button></div>
          </details>
        </div>
        <p data-memory-status role="status"></p><button type="button" class="wb-button" data-memory-retry hidden>${m("common.retry")}</button>
        <section class="project-team-memory" data-memory-team></section>
        <section class="project-memory-material-results" data-memory-materials hidden></section>
        <h3 class="memory-personal-heading">${m("projects.memoryPersonalTitle")}</h3>
        <div class="project-memory-list" data-memory-entries></div><button type="button" class="wb-button" data-memory-more hidden>${m("projects.memoryMore")}</button>
        </div>
      </section>`,
      );
      section = host.querySelector<HTMLElement>(".project-memory-view")!;
      const terrainHost = section.querySelector<HTMLElement>("[data-memory-terrain]")!;
      const records = section.querySelector<HTMLElement>("[data-memory-records]")!;
      teamLifecycle = new AbortController();
      team = mountProjectTeamMemory(
        section.querySelector<HTMLElement>("[data-memory-team]")!,
        records,
        id,
        t,
        request,
        teamLifecycle.signal,
      );
      records.addEventListener("click", (event) => {
        const button =
          event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>("[data-memory-team-publish]")
            : null;
        if (button?.dataset.memoryTeamPublish) void team?.publish(button.dataset.memoryTeamPublish, button);
      });
      const initial = memoryBrowse(new URLSearchParams(location.search));
      terrain = createMemoryTerrainView(t, terrainHost, path(), project, initial, (browse) =>
        rememberMemoryBrowse(project, browse),
      );
      const modes = section.querySelectorAll<HTMLButtonElement>("[data-memory-mode]");
      const chooseMode = (next: MemoryView) => {
        for (const control of modes) control.setAttribute("aria-pressed", String(control.dataset.memoryMode === next));
        records.hidden = next !== "records";
        terrainHost.hidden = !records.hidden;
        if (next === "records") {
          rememberMemoryBrowse(project, { mode: "records" });
          terrain?.hide();
        } else terrain?.show(next);
      };
      for (const mode of modes)
        mode.onclick = () => {
          if (mode.getAttribute("aria-pressed") === "true") return;
          chooseMode(mode.dataset.memoryMode as MemoryView);
          if (mode.dataset.memoryMode === "records") void load();
        };
      chooseMode(initial.mode);
      const importPackage = section.querySelector<HTMLButtonElement>("[data-memory-packages-import]")!;
      const exportPackage = section.querySelector<HTMLButtonElement>("[data-memory-packages-export]")!;
      section.addEventListener("click", (event) => {
        const source =
          event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-package-source]") : null;
        if (source) packages.showReferences(project, source);
      });
      section.querySelector<HTMLElement>("[data-memory-materials]")!.onclick = (event) => {
        if (!(event.target instanceof Element)) return;
        const trigger = event.target.closest<HTMLButtonElement>(
          "[data-material-search-result],[data-material-search-refresh]",
        );
        if (!trigger) return;
        if (trigger.hasAttribute("data-material-search-refresh")) {
          void load();
          return;
        }
        const hit = materials?.hits[Number(trigger.dataset.materialSearchResult)];
        if (hit) packages.showMaterial(project, hit, trigger);
      };
      importPackage.onclick = () => packages.showImport(project, importPackage, () => void load());
      exportPackage.onclick = () => packages.showExport(project, exportPackage);
      const searchForm = section.querySelector<HTMLFormElement>("[data-memory-search]")!;
      const query = searchForm.querySelector<HTMLInputElement>("input")!;
      const updateSearch = (value: string) => {
        search = value;
        if (!search) {
          materials = undefined;
          renderMaterials();
        }
        void load();
      };
      searchForm.onsubmit = (event) => {
        event.preventDefault();
        updateSearch(query.value.trim());
      };
      const clearQuery = () => {
        if (!query.value && search) updateSearch("");
      };
      query.oninput = clearQuery;
      query.addEventListener("search", clearQuery);
      const rebuild = section.querySelector<HTMLButtonElement>("[data-memory-index-rebuild]")!;
      rebuild.onclick = () => void rebuildIndex(rebuild);
      section.querySelector<HTMLButtonElement>("[data-memory-index-refresh]")!.onclick = () => void load();
      section.querySelector<HTMLButtonElement>("[data-memory-retry]")!.onclick = () => void load();
      section.querySelector<HTMLButtonElement>("[data-memory-more]")!.onclick = () => void load(true);
      void load();
    },
    hide() {
      packages.close();
      teamLifecycle?.abort();
      team = undefined;
      terrain?.hide();
      terrain = undefined;
      controller?.abort();
      for (const current of historyRequests.values()) current.abort();
      historyRequests.clear();
      materials = undefined;
      section = undefined;
    },
  };
}
