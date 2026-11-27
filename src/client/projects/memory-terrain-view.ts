import { isProjectMemoryScope } from "../../shared/project-memory/contracts.js";
import { memoryPackageSources } from "./memory-packages.js";
import {
  memoryMapLayout,
  memoryMapLayouts,
  memorySourceHref,
  type MemoryBrowse,
  type MemoryMapLayout,
} from "./memory-source-link.js";
import { escapeHtml as escape } from "../../shared/html.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { MemoryEntry, MemoryTerrain, MemoryTerrainPlace } from "../../shared/project-memory/contracts.js";
import { memoryDisplayName } from "../../shared/project-memory/language.js";
import { codexIcon } from "../codex-icons.js";
import { harnessApi } from "../harness/api.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import { mountMemoryTerrainNetwork } from "./memory-terrain-layout.js";

import { STORAGE_KEYS, storage } from "../storage.js";

const mapNames = {
  network: "projects.memoryMapNetwork",
  timeline: "projects.memoryMapTimeline",
  focus: "projects.memoryMapFocus",
} as const;
const filters = {
  all: "projects.memoryMapAllLinks",
  dependency: "projects.memoryMapDependencies",
  source: "projects.memoryRelationSameSource",
} as const;
type Filter = keyof typeof filters;
type View = "terrain" | "evidence";
const overview = "";
export function createMemoryTerrainView(
  t: Translate,
  host: HTMLElement,
  path: string,
  project: string,
  initial: MemoryBrowse,
  onBrowse: (browse: MemoryBrowse) => void,
) {
  const api = harnessApi(t);
  const m = (key: Parameters<typeof messageHtml>[0]) => messageHtml(key, {}, t);
  let request: AbortController | undefined;
  let retryRestore: string | undefined;
  let messageRequest: AbortController | undefined;
  let data: MemoryTerrain | undefined;
  let view: View | undefined;
  let network: ReturnType<typeof mountMemoryTerrainNetwork> | undefined;
  let topic = initial.topic ?? "";
  let plate = initial.plate ?? "";
  let selected = initial.place ?? overview;
  let layout = initial.layout ?? memoryMapLayout(storage.get(STORAGE_KEYS.memoryMapLayout)) ?? "network";
  let hops: 1 | 2 = initial.hops ?? 2;
  let filter: Filter = "all";
  let hideFocusDetail = false;
  let practice = false;
  let revealed = false;

  const get = <T extends Element>(selector: string) => host.querySelector<T>(selector)!;
  const button = (id: string, caption: string) =>
    `<button type="button" class="wb-button" data-place-action="${id}">${caption}</button>`;
  const iconButton = (action: string, icon: string, caption: string, disabled = false, pressed?: boolean) =>
    `<button type="button" class="wb-button memory-map-action" data-place-action="${action}" aria-label="${escape(caption)}"
      ${disabled ? "disabled" : ""}${pressed === undefined ? "" : ` aria-pressed="${pressed}"`}>${codexIcon(icon)}
      <span class="memory-map-action-label" aria-hidden="true">${escape(caption)}</span></button>`;
  const titleFor = (entry: Pick<MemoryEntry, "key" | "title">) => entry.title ?? memoryDisplayName(entry.key);
  const displayScope = (entry: MemoryEntry) =>
    isProjectMemoryScope(entry.scope) ? t("common.project") : memoryDisplayName(entry.scope);
  const scopeFor = (entry: MemoryEntry) =>
    isProjectMemoryScope(entry.scope) &&
    (data?.places.filter(({ entry: other }) => other.key === entry.key).length ?? 0) < 2
      ? ""
      : displayScope(entry);
  const sources = (entry: MemoryEntry) => {
    const links = new Map(entry.sources.map((source) => [source.messageId, source]));
    return `<ul class="memory-place-sources">${Array.from(
      links.values(),
      ({ conversationId, messageId }, index) => `<li><details data-memory-source-message="${escape(messageId)}"
       data-memory-source-conversation="${escape(conversationId)}"><summary>${m("projects.memoryTerrainOpenEvidence")}
       ${links.size > 1 ? `<span>${index + 1}</span>` : ""}</summary><blockquote data-memory-source-content hidden data-i18n-ignore></blockquote>
       <p data-memory-source-status role="status" hidden></p>
       <a href="${escape(memorySourceHref(project, { conversationId, messageId }, browse()))}">${m("projects.memorySourcePosition")}</a></details></li>`,
    ).join(
      "",
    )}${memoryPackageSources(t, entry.packages, entry)}${entry.manual?.length ? `<li>${m("projects.memoryManualSource")}</li>` : ""}</ul>`;
  };
  function browse(): MemoryBrowse {
    return {
      mode: view ?? "terrain",
      topic: topic || undefined,
      plate: plate || undefined,
      place: selected || undefined,
      layout: view === "terrain" ? layout : undefined,
      hops,
    };
  }
  const timeFormat = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
  const markerTimeFormat = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  function mapControls() {
    return `<label class="wb-field memory-map-layout-switch"><span class="sr-only">${m("projects.memoryMapLayout")}</span>
      <select class="wb-select" data-memory-layout>${memoryMapLayouts
        .map((key) => `<option value="${key}"${layout === key ? " selected" : ""}>${m(mapNames[key])}</option>`)
        .join("")}</select></label>`;
  }
  function filterControls() {
    if (layout === "focus") {
      return `<div class="memory-map-hops" role="group" aria-label="${escape(t("projects.memoryMapDepth"))}">
        ${([1, 2] as const).map((value) => `<button type="button" class="wb-button" data-memory-hops="${value}" aria-pressed="${value === hops}">${m(value === 1 ? "projects.memoryMapOneHop" : "projects.memoryMapTwoHops")}</button>`).join("")}
        </div>`;
    }
    return `<label class="wb-field memory-map-filter" data-memory-filter-active="${filter !== "all"}">
      <span class="memory-map-filter-icon" aria-hidden="true">${codexIcon("slidersHorizontal")}</span><span class="sr-only">${m("projects.memoryMapLinkFilter")}</span>
      <select class="wb-select" data-memory-filter>${Object.entries(filters)
        .map(([key, label]) => `<option value="${key}"${filter === key ? " selected" : ""}>${m(label)}</option>`)
        .join("")}</select></label>`;
  }
  function mapShell(content: string) {
    if (view !== "terrain") return content;
    return `<div class="memory-terrain-controls" data-terrain-view="terrain">${mapControls()}</div>${content}`;
  }
  function current() {
    return data?.places.find(({ entry }) => entry.id === selected)?.entry;
  }
  function relatedMemories(entry: MemoryEntry) {
    const landmarks = new Map([
      ...(data?.places.map(({ entry }) => [entry.id, entry] as const) ?? []),
      ...(data?.related.map((item) => [item.id, item] as const) ?? []),
    ]);
    const links = data?.links.flatMap(({ from, to, kind }) => {
      if (entry.id !== from && entry.id !== to) return [];
      const other = landmarks.get(from === entry.id ? to : from);
      if (!other) return [];
      const labels = {
        related: "projects.memoryRelationRelated",
        dependsOn: entry.id === from ? "projects.memoryRelationDependsOn" : "projects.memoryRelationRequiredBy",
        refines: entry.id === from ? "projects.memoryRelationRefines" : "projects.memoryRelationRefinedBy",
        sameTopic: "projects.memoryRelationSameTopic",
        sameSource: "projects.memoryRelationSameSource",
      } as const;
      return [
        `<li><button type="button" class="wb-button" data-memory-related="${escape(other.id)}">
        <span><strong data-i18n-ignore>${escape(titleFor(other))}</strong><small>${m(labels[kind])}</small></span>
        ${codexIcon("chevronRight")}</button></li>`,
      ];
    });
    return links?.length
      ? `<section class="memory-place-related"><h4>${m("projects.memoryRelatedMemories")}</h4><ul>${links.join("")}</ul></section>`
      : "";
  }
  function nextHops() {
    if (layout !== "focus" || hops !== 2 || !data) return "";
    const direct = new Map(data.places.filter(({ depth }) => depth === 1).map(({ entry }) => [entry.id, entry]));
    const links = data.links;
    const items = data.places.flatMap(({ depth, entry }) => {
      if (depth !== 2) return [];
      const connection = links.find(
        ({ from, to }) => (from === entry.id && direct.has(to)) || (to === entry.id && direct.has(from)),
      );
      if (!connection) return [];
      const via = direct.get(connection.from === entry.id ? connection.to : connection.from)!;
      return [
        `<li><button type="button" class="wb-button" data-memory-related="${escape(entry.id)}">
        <span><strong data-i18n-ignore>${escape(titleFor(entry))}</strong><small>${messageHtml("projects.memoryMapVia", { title: titleFor(via) }, t)}</small></span>
        ${codexIcon("chevronRight")}</button></li>`,
      ];
    });
    return items.length
      ? `<section class="memory-place-related"><h4>${m("projects.memoryMapTwoHops")}</h4><ul>${items.join("")}</ul></section>`
      : "";
  }
  function showPlace(animate = false) {
    messageRequest?.abort();
    if (!data?.plate) return;
    onBrowse(browse());
    const entry = current();
    const title = entry ? escape(titleFor(entry)) : "";
    const detail = get<HTMLElement>("[data-memory-place-detail]");
    for (const control of host.querySelectorAll<HTMLButtonElement>("[data-memory-place]"))
      control.setAttribute("aria-pressed", String(control.dataset.memoryPlace === selected));
    if (view === "terrain") {
      detail.classList.toggle("is-empty", !entry);
      detail.hidden = hideFocusDetail && layout === "focus";
      network?.select(selected, animate);
    }
    if (view === "evidence" && entry) {
      setMessageHtml(
        detail,
        `<div class="memory-evidence-flow">
        <section><h4>${m("projects.memorySources")}</h4>${sources(entry)}</section>
        <section><h4 data-i18n-ignore>${title}</h4>${answer(entry)}</section>
        <section><h4>${m("projects.memoryTerrainScope")}</h4><p data-i18n-ignore>${escape(displayScope(entry))}</p></section>
        </div>`,
      );
      mountSources(detail);
      return;
    }
    const scope = entry ? scopeFor(entry) : "";
    const time =
      view === "terrain" && layout === "timeline"
        ? data.places.find((place) => place.entry.id === selected)?.time
        : undefined;
    const when = time
      ? `<p>${m(time.source ? "projects.memoryMapSourceTime" : "projects.memoryMapSavedTime")}
      <time datetime="${new Date(time.at).toISOString()}" data-i18n-ignore>${escape(timeFormat.format(time.at))}</time></p>`
      : "";
    const content = entry
      ? `<div class="memory-place-heading"><div><h3 data-i18n-ignore>${title}</h3>${scope ? `<p data-i18n-ignore>${escape(scope)}</p>` : ""}${when}</div>
          ${iconButton("close-place", "x", t("common.close"))}</div>${
            practice && !revealed
              ? `<p>${m("projects.memoryTerrainRecallHint")}</p>${button("reveal", m("projects.memoryTerrainReveal"))}`
              : `${answer(entry)}${entry.sources.length || entry.packages?.length || entry.manual?.length ? `<h4>${m("projects.memorySources")}</h4>${sources(entry)}` : ""}${relatedMemories(entry)}${nextHops()}`
          }`
      : `<p class="memory-place-empty">${m("projects.memoryTerrainChoose")}</p>`;
    setMessageHtml(detail, content);
    mountSources(detail);
  }

  function mountSources(detail: HTMLElement) {
    for (const source of detail.querySelectorAll<HTMLDetailsElement>("[data-memory-source-message]")) {
      source.ontoggle = async () => {
        const quote = source.querySelector<HTMLElement>("[data-memory-source-content]")!;
        const info = source.querySelector<HTMLElement>("[data-memory-source-status]")!;
        quote.textContent = "";
        quote.hidden = true;
        info.hidden = !source.open;
        if (!source.open) return;
        for (const other of detail.querySelectorAll<HTMLDetailsElement>("[data-memory-source-message][open]"))
          if (other !== source) other.open = false;
        messageRequest?.abort();
        const current = new AbortController();
        messageRequest = current;
        info.textContent = t("common.pageLoading");
        const params = new URLSearchParams({
          message: source.dataset.memorySourceMessage!,
          conversation: source.dataset.memorySourceConversation!,
        });
        try {
          const { text } = await api<{ text: string }>(
            path + "memory-source?" + params,
            "GET",
            undefined,
            current.signal,
          );
          if (current.signal.aborted || !source.open || !source.isConnected) return;
          quote.textContent = text;
          quote.hidden = false;
          info.hidden = true;
        } catch {
          if (!current.signal.aborted && source.open) info.textContent = t("projects.memoryTerrainEvidenceUnavailable");
        }
      };
    }
  }

  function answer(entry: MemoryEntry) {
    return `<p class="memory-place-value"><code data-i18n-ignore>${escape(entry.value ?? "")}</code></p>`;
  }

  function render() {
    if (!data?.plate || !view) {
      setMessageHtml(host, mapShell(`<p class="memory-terrain-state">${m("projects.memoryEmpty")}</p>`));
      return;
    }
    const topicOptions = data.topics
      .map(
        ({ id, name, title }) =>
          `<option value="${id}"${id === topic ? " selected" : ""} data-i18n-ignore>${escape(title ?? memoryDisplayName(name))}</option>`,
      )
      .join("");
    const plateOptions = data.plates
      .map((id, index) => `<option value="${id}"${id === plate ? " selected" : ""}>${index + 1}</option>`)
      .join("");
    const selectors = `<label class="wb-field"><span class="sr-only">${m("projects.memoryTerrainTopic")}</span>
      <select class="wb-select" data-memory-topic>${topicOptions}</select></label>${
        data.plates.length > 1
          ? `<label class="wb-field"><span class="sr-only">${m("projects.memoryTerrainPlate")}</span><select class="wb-select" data-memory-plate>${plateOptions}</select></label>`
          : ""
      }`;
    const marker = ({ entry, depth, time }: MemoryTerrainPlace) => {
      const title = titleFor(entry);
      const scope = scopeFor(entry);
      const label = scope ? `${title} · ${scope}` : title;
      const date =
        layout === "timeline" && time
          ? `<small><time datetime="${new Date(time.at).toISOString()}">${escape(markerTimeFormat.format(time.at))}</time></small>`
          : scope
            ? `<small>${escape(scope)}</small>`
            : "";
      const icon = layout === "timeline" ? "clock" : depth === 0 ? "compass" : "gitBranch";
      return `<button type="button" class="memory-terrain-marker" data-memory-place="${escape(entry.id)}"
         ${depth === undefined ? "" : `data-memory-depth="${depth}"`} aria-label="${escape(label)}" title="${escape(label)}" aria-pressed="false">
         <span class="memory-terrain-pin" aria-hidden="true">${codexIcon(icon)}</span><span class="memory-terrain-label" data-i18n-ignore>
         <span class="memory-terrain-title">${escape(title)}</span>${date}</span></button>`;
    };
    const page = data.plates.indexOf(data.plate);
    const paging =
      data.plates.length > 1
        ? `<div class="memory-map-pages">
         ${iconButton("page-prev", "chevronLeft", t("projects.memoryTerrainPreviousPage"), page <= 0)}
         <span aria-live="polite">${messageHtml("projects.pagePosition", { page: page + 1, pages: data.plates.length }, t)}</span>
         ${iconButton("page-next", "chevronRight", t("projects.memoryTerrainNextPage"), page >= data.plates.length - 1)}</div>`
        : "";
    const terrain = `<div class="memory-terrain-controls" data-terrain-view="terrain">
        <div class="memory-map-controls">${mapControls()}${filterControls()}</div>
        <div class="memory-terrain-actions">
        ${iconButton("practice", "circleHelp", t(practice ? "projects.memoryTerrainEndPractice" : "projects.memoryTerrainPractice"), false, practice)}
        ${iconButton("next", "chevronRight", t("projects.memoryTerrainNext"))}</div>${paging}</div>
        <div class="memory-terrain-layout" data-memory-arrangement="${layout}">
        <div class="memory-terrain-scene" role="group" aria-label="${escape(t(mapNames[layout]))}">
         <canvas aria-hidden="true"></canvas>
         ${data.places.map(marker).join("")}
         <div class="memory-map-legend">
          <span>${m("projects.memoryMapContentLink")}</span><span>${m("projects.memoryRelationSameSource")}</span>
         </div></div>
         <aside class="memory-place-detail" aria-live="polite" data-memory-place-detail></aside></div>`;
    const evidence = `<div class="memory-terrain-controls" data-terrain-view="evidence">${selectors}</div>
      <div class="memory-evidence-scopes">${data.places
        .map(
          ({ entry }) =>
            `<button type="button" class="wb-button" data-memory-place="${entry.id}" data-i18n-ignore aria-pressed="false">${escape(displayScope(entry))}</button>`,
        )
        .join("")}</div><div data-memory-place-detail aria-live="polite"></div>`;
    setMessageHtml(host, view === "terrain" ? terrain : evidence);
    const canvas = host.querySelector("canvas");
    if (canvas) {
      const markers = new Map(
        [...host.querySelectorAll<HTMLButtonElement>(".memory-terrain-marker")].map((control) => [
          control.dataset.memoryPlace!,
          control,
        ]),
      );
      const links = data.links.filter(
        ({ kind }) => filter === "all" || (filter === "dependency" ? kind === "dependsOn" : kind === "sameSource"),
      );
      network = mountMemoryTerrainNetwork(canvas, markers, data.places, links, layout, hops);
    }
    showPlace();
  }

  async function load(restore?: string) {
    retryRestore = restore;
    request?.abort();
    messageRequest?.abort();
    network?.close();
    network = undefined;
    data = undefined;
    const currentRequest = new AbortController();
    request = currentRequest;
    const params = new URLSearchParams();
    if (topic) params.set("topic", topic);
    if (plate) params.set("plate", plate);
    if (selected) params.set("place", selected);
    if (view === "terrain") {
      params.set("view", layout === "network" ? "overview" : layout);
      if (layout === "focus") params.set("hops", String(hops));
    }
    setMessageHtml(host, mapShell(`<p class="memory-terrain-state" role="status">${m("common.pageLoading")}</p>`));
    try {
      const response = await api<MemoryTerrain>(
        path + "memory-terrain?" + params,
        "GET",
        undefined,
        currentRequest.signal,
      );
      if (currentRequest.signal.aborted) return;
      response.places = response.places.filter(({ entry }) => entry.state === "active");
      response.links ??= [];
      response.related ??= [];
      data = response;
      topic = response.topic ?? "";
      plate = response.plate ?? "";
      if (view === "terrain" && layout === "focus") selected = response.place ?? overview;
      else if (!response.places.some(({ entry }) => entry.id === selected))
        selected = response.place ?? (view === "evidence" ? (response.places[0]?.entry.id ?? overview) : overview);
      render();
      if (restore)
        (
          host.querySelector<HTMLElement>(restore) ?? host.querySelector<HTMLElement>(".memory-terrain-marker")
        )?.focus();
    } catch (error) {
      if (currentRequest.signal.aborted) return;
      setMessageHtml(
        host,
        mapShell(
          `<p role="status" class="memory-terrain-state">${escape(error instanceof Error ? error.message : t("harness.errorUnavailable"))}</p>${button("retry", m("common.retry"))}`,
        ),
      );
      if (restore) get<HTMLButtonElement>('[data-place-action="retry"]').focus();
    }
  }

  host.onchange = (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    if (event.target.matches("[data-memory-layout]")) {
      const next = memoryMapLayout(event.target.value);
      if (!next || next === layout) return;
      layout = next;
      filter = "all";
      plate = "";
      topic = "";
      hideFocusDetail = false;
      storage.set(STORAGE_KEYS.memoryMapLayout, layout);
      onBrowse(browse());
      void load("[data-memory-layout]");
      return;
    }
    if (event.target.matches("[data-memory-filter]")) {
      const value = event.target.value;
      if (value !== "all" && value !== "source" && value !== "dependency") return;
      filter = value;
      network?.close();
      network = undefined;
      render();
      get<HTMLSelectElement>("[data-memory-filter]").focus();
      return;
    }
    if (event.target.matches("[data-memory-topic]")) {
      topic = event.target.value;
      plate = "";
    } else if (event.target.matches("[data-memory-plate]")) plate = event.target.value;
    else return;
    selected = overview;
    revealed = false;
    void load(event.target.matches("[data-memory-topic]") ? "[data-memory-topic]" : "[data-memory-plate]");
  };
  function choosePlace(id: string, restore: boolean, touch = false) {
    const pivot = view === "terrain" && layout === "focus" && id !== selected;
    selected = id;
    revealed = false;
    hideFocusDetail = false;
    if (pivot) plate = "";
    const marker = host.querySelector<HTMLButtonElement>(`[data-memory-place="${CSS.escape(id)}"]`);
    if (pivot || !marker) {
      void load('.memory-terrain-marker[aria-pressed="true"]');
      return;
    }
    showPlace(true);
    if (restore) marker.focus({ preventScroll: true });
    if (touch && view === "terrain" && matchMedia("(max-width: 760px)").matches)
      get<HTMLElement>("[data-memory-place-detail]").scrollIntoView({ block: "nearest" });
  }

  host.onclick = (event) => {
    const control = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!control || !host.contains(control)) return;
    if (control.dataset.memoryHops) {
      const next = control.dataset.memoryHops === "1" ? 1 : 2;
      if (next === hops) return;
      hops = next;
      plate = "";
      hideFocusDetail = false;
      onBrowse(browse());
      void load(`[data-memory-hops="${hops}"]`);
      return;
    }
    if (control.dataset.memoryRelated || control.dataset.memoryPlace !== undefined) {
      choosePlace(
        control.dataset.memoryRelated ?? control.dataset.memoryPlace!,
        !!control.dataset.memoryRelated,
        !!event.detail,
      );
      return;
    }
    switch (control.dataset.placeAction) {
      case "retry":
        void load(retryRestore ?? "[data-memory-topic], .memory-terrain-marker");
        break;
      case "practice": {
        practice = !practice;
        revealed = false;
        if (practice && !selected) selected = data?.places[0]?.entry.id ?? overview;
        const caption = t(practice ? "projects.memoryTerrainEndPractice" : "projects.memoryTerrainPractice");
        control.querySelector(".memory-map-action-label")!.textContent = caption;
        control.setAttribute("aria-label", caption);
        control.setAttribute("aria-pressed", String(practice));
        showPlace();
        break;
      }
      case "close-place": {
        const marker = host.querySelector<HTMLButtonElement>(`[data-memory-place="${CSS.escape(selected)}"]`);
        if (view === "terrain" && layout === "focus") hideFocusDetail = true;
        else selected = overview;
        revealed = false;
        showPlace();
        marker?.focus();
        break;
      }
      case "page-prev":
      case "page-next": {
        const action = control.dataset.placeAction;
        const index = data?.plates.indexOf(plate) ?? -1;
        const next = data?.plates[index + (action === "page-prev" ? -1 : 1)];
        if (!next) break;
        plate = next;
        if (layout !== "focus") selected = overview;
        revealed = false;
        void load(`[data-place-action="${action}"]:not(:disabled)`);
        break;
      }
      case "next": {
        const places = data?.places ?? [];
        const index = places.findIndex(({ entry }) => entry.id === selected);
        const next = places[(index + 1) % places.length]?.entry.id;
        if (next) choosePlace(next, false);
        break;
      }
      case "reveal":
        revealed = true;
        showPlace();
        get<HTMLElement>("[data-memory-place-detail] code, [data-memory-place-detail] [role=status]").setAttribute(
          "tabindex",
          "-1",
        );
        get<HTMLElement>("[data-memory-place-detail] [tabindex='-1']").focus();
        break;
    }
  };
  return {
    show(next: View) {
      view = next;
      if (view === "evidence") practice = revealed = false;
      onBrowse(browse());
      void load();
    },
    hide() {
      request?.abort();
      messageRequest?.abort();
      network?.close();
      network = undefined;
      data = undefined;
      setMessageHtml(host, "");
    },
  };
}
