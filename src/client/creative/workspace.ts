import type { ComposerMount } from "../../gadget/system/composer/host.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { ProjectDocumentTree } from "../../shared/documents/navigation.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, messageHtml, messageAttributes, localizeAttribute, getBrowserI18n } from "../i18n.js";
import { copyPersonalDocument } from "./document-copy.js";
import { documentTreeApi } from "../documents/authoring/tree-api.js";
import { DocumentModal } from "../documents/modal.js";
import { codexIcon } from "../codex-icons.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import { creativeAssetsApi } from "./assets-api.js";
import { CreativeCovers } from "./covers.js";
import { creativeCards, type CreativeCard, type CreativeFilter } from "./cards.js";
import { LazyCreativeAssetsPanel } from "./assets-lazy.js";
import type { ProjectReadAhead } from "./read-ahead.js";
import { projectEmptyView, projectOverviewHeading, projectOverviewTabs } from "./project-view.js";

import type { ContentProject } from "./contracts.js";
export type { ContentProject } from "./contracts.js";
/** Owns discovery and navigation only. Editors, creation jobs and file copies remain separate services. */
export function createCreativeWorkspace(
  t: Translate,
  identity: string,
  projects: () => ContentProject[],
  navigate: (path: string) => void,
  mountComposer: ComposerMount,
  context = "personal",
  readAhead?: ProjectReadAhead,
) {
  let host: HTMLElement | null = null,
    epoch = 0,
    query = "",
    limit = 24,
    locale = "",
    followedAsset = "";
  const covers = new CreativeCovers(t);
  let scope = "personal";
  let tree: ProjectDocumentTree = { projectId: scope, version: 0, nodes: [] };
  let assets: CreativeAsset[] = [],
    cursor: string | null = null,
    filter: CreativeFilter = "all",
    docsLoaded = false,
    docsReady = false,
    assetsLoaded = false,
    failed = false,
    contribute = false,
    originals = true,
    capabilitiesLoaded = false,
    paging = false,
    request: AbortController | null = null;
  let composer: ReturnType<ComposerMount> | null = null;
  const modal = new DocumentModal(t, context === "personal" ? "creativeActionDialog" : "projectCreativeActionDialog"),
    assetPanel = new LazyCreativeAssetsPanel(t, context + "CreativeAssetsDialog", identity);
  const open = (id: string, edit = false) =>
    navigate("/documents?" + new URLSearchParams({ project: scope, document: id, ...(edit ? { edit: "1" } : {}) }));
  function notice(text: string, failed = false) {
    const el = host?.querySelector<HTMLElement>("[data-creative-status]");
    if (el) {
      el.textContent = text;
      el.dataset.error = String(failed);
    }
  }
  function followAsset() {
    const params = new URL(location.href).searchParams,
      id = params.get("asset"),
      version = params.get("assetVersion") || undefined;
    if (!id) {
      if (followedAsset) assetPanel.close();
      followedAsset = "";
      return;
    }
    const key = JSON.stringify([scope, id, version]);
    if (key === followedAsset) return;
    followedAsset = key;
    const project = scope,
      generation = epoch;
    void assetPanel
      .follow(
        project,
        id,
        async () => {
          if (project === scope && host) await refresh();
        },
        version,
      )
      .catch(() => {
        if (generation === epoch && host) notice(t("documents.unavailable"), true);
      });
  }
  async function create() {
    if (!docsReady || !contribute) return;
    const sourceScope = scope,
      target = host,
      generation = epoch;
    const response = await documentTreeApi.commit({
      id: crypto.randomUUID(),
      projectId: scope,
      treeVersion: tree.version,
      intent: {
        kind: "create",
        title: t("documents.untitled"),
        locale: document.documentElement.lang || "en",
        parentId: null,
      },
    });
    if (generation !== epoch || host !== target || scope !== sourceScope) return;
    open(response.operation.documentId, true);
  }
  function cards() {
    if (!host) return;
    const list: CreativeCard[] = [
      ...(filter === "all" || filter === "document"
        ? tree.nodes.map((n) => ({ kind: "document" as const, value: n.document }))
        : []),
      ...assets
        .filter(
          (asset) =>
            (filter === "trash" ? ["trashed", "purging"].includes(asset.state) : asset.state === "saved") &&
            (filter === "all" || filter === "trash" || filter === asset.kind),
        )
        .map((value) => ({ kind: "asset" as const, value })),
    ]
      .filter(({ value }) => value.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .sort((a, b) => b.value.updatedAt - a.value.updatedAt);
    setMessageHtml(
      host.querySelector("[data-creative-grid]")!,
      creativeCards(t, list.slice(0, limit), scope === "personal") ||
        (scope !== "personal" &&
        docsLoaded &&
        assetsLoaded &&
        capabilitiesLoaded &&
        !failed &&
        !query &&
        !cursor &&
        filter === "all"
          ? projectEmptyView(t, contribute)
          : `<p class="resource-empty">${e(t(!docsLoaded || !assetsLoaded ? "documents.loading" : failed ? "creative.assetLoadFailed" : cursor ? "creative.assetMoreAvailable" : query ? "creative.assetNoMatches" : filter === "trash" ? "creative.assetTrashEmpty" : "creative.empty"))}</p>`),
    );
    covers.render(host.querySelector<HTMLElement>("[data-creative-grid]")!);
    const more = host.querySelector<HTMLButtonElement>("[data-creative-more]")!;
    more.hidden = list.length <= limit && !cursor;
    more.disabled = paging;
    host
      .querySelector("[data-creative-grid]")!
      .setAttribute("aria-busy", String(!docsLoaded || !assetsLoaded || paging));
    host.querySelector<HTMLButtonElement>("[data-creative-new]")!.disabled = !contribute || !docsReady;
    host.querySelector<HTMLButtonElement>("[data-creative-import]")!.disabled = !contribute || !originals;
    host.querySelector<HTMLButtonElement>("[data-creative-import]")!.hidden =
      filter === "trash" || !capabilitiesLoaded || !originals;
    host.querySelector<HTMLButtonElement>("[data-creative-new]")!.hidden = filter === "trash";
    host.querySelector<HTMLButtonElement>("[data-creative-retry]")!.hidden = !failed;
    host.querySelector<HTMLElement>("[data-system-composer]")!.hidden = filter === "trash";
    if (scope !== "personal") {
      const empty =
        docsLoaded && assetsLoaded && capabilitiesLoaded && !failed && !tree.nodes.length && !assets.length && !cursor;
      host.querySelector(".project-overview")?.setAttribute("data-empty", String(empty));
      const toolbar = host.querySelector<HTMLElement>(".project-content-toolbar");
      if (toolbar) toolbar.hidden = empty && filter === "all" && !query;
    }
    host.querySelector("[data-creative-library]")!.textContent = t(
      filter === "trash"
        ? "creative.assetFileTrash"
        : scope === "personal"
          ? "creative.assetLibrary"
          : "creative.content",
    );
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-creative-filter]")) {
      button.setAttribute("aria-pressed", String(button.dataset.creativeFilter === filter));
      button.hidden =
        ["slides", "web", "trash"].includes(button.dataset.creativeFilter ?? "") && (!capabilitiesLoaded || !originals);
    }
  }
  getBrowserI18n().subscribe(() => {
    if (!host) return;
    locale = document.documentElement.lang;
    composer?.update();
    cards();
    notice(failed ? t("creative.assetLoadFailed") : !docsLoaded || !assetsLoaded ? t("documents.loading") : "", failed);
  });
  async function refresh() {
    const generation = ++epoch,
      project = scope,
      state = filter === "trash" ? "trashed" : "saved";
    request?.abort();
    const prepared = filter === "trash" ? null : readAhead?.take(project);
    request = prepared?.controller ?? new AbortController();
    const signal = request.signal;
    docsLoaded = filter === "trash";
    docsReady = false;
    assetsLoaded = false;
    failed = false;
    contribute = false;
    capabilitiesLoaded = false;
    originals = true;
    assets = [];
    cursor = null;
    paging = false;
    cards();
    notice(t("documents.loading"));
    const live = () => generation === epoch && !!host && !signal.aborted;
    await Promise.allSettled([
      filter === "trash"
        ? Promise.resolve()
        : (prepared?.tree ?? documentTreeApi.read(project, signal))
            .then((value) => {
              if (live()) {
                tree = value;
                docsLoaded = true;
                docsReady = true;
                cards();
              }
            })
            .catch(() => {
              if (live()) {
                docsLoaded = true;
                failed = true;
                cards();
              }
            }),
      (prepared?.assets ?? creativeAssetsApi.list(project, undefined, signal, state))
        .then((value) => {
          if (live()) {
            assets = value.assets;
            cursor = value.nextCursor;
            assetsLoaded = true;
            cards();
          }
        })
        .catch(() => {
          if (live()) {
            assetsLoaded = true;
            failed = true;
            cards();
          }
        }),
      (prepared?.capabilities ?? creativeAssetsApi.capabilities(project, signal))
        .then((value) => {
          if (live()) {
            contribute = value.contribute;
            originals = value.originals !== false;
            capabilitiesLoaded = true;
            cards();
          }
        })
        .catch(() => {
          if (live()) {
            failed = true;
            cards();
          }
        }),
    ]);
    if (live())
      notice(failed ? t("creative.assetLoadFailed") : !originals ? t("creative.documentOnlyProject") : "", failed);
  }
  async function more() {
    if (paging) return;
    limit += 24;
    if (!cursor) {
      cards();
      return;
    }
    const generation = epoch,
      project = scope;
    paging = true;
    cards();
    try {
      const page = await creativeAssetsApi.list(
        project,
        cursor,
        request?.signal,
        filter === "trash" ? "trashed" : "saved",
      );
      if (generation !== epoch || !host) return;
      assets = [...new Map([...assets, ...page.assets].map((value) => [value.id, value])).values()];
      cursor = page.nextCursor;
    } catch {
      if (generation === epoch) {
        failed = true;
        notice(t("creative.assetRefreshNeeded"), true);
      }
    } finally {
      if (generation === epoch) {
        paging = false;
        cards();
      }
    }
  }
  async function assetAction(action: "import" | "read" | "copy", id?: string) {
    const generation = epoch,
      project = scope;
    notice(t("documents.loading"));
    try {
      await assetPanel.open(
        action,
        project,
        assets.find((a) => a.id === id),
        async () => {
          if (generation === epoch && project === scope && host) {
            if (action === "import") filter = "all";
            await refresh();
          }
        },
      );
    } catch {
      if (generation === epoch) notice(t("documents.unavailable"), true);
      return;
    }
    if (generation === epoch) notice("");
  }
  async function copy(document: DocumentRecord) {
    if (await copyPersonalDocument(modal, t, document, projects())) notice(t("creative.copyDone"));
  }
  return {
    show(target: HTMLElement, project = "personal") {
      if (
        host === target &&
        scope === project &&
        locale === document.documentElement.lang &&
        target.querySelector(".creative-workspace")
      ) {
        const details = projects().find((p) => p.id === project),
          name = details?.name;
        if (project !== "personal" && name) {
          target.querySelector("[data-creative-heading]")!.textContent = name;
          const crumb = target.querySelector<HTMLElement>("[data-project-breadcrumb-current]");
          if (crumb) {
            crumb.textContent = name;
            crumb.title = name;
          }
          const scopeLabel = target.querySelector("[data-creative-scope]");
          if (scopeLabel) scopeLabel.textContent = name;
          const code = target.querySelector<HTMLElement>("[data-project-code]");
          if (code) {
            code.textContent = details?.code || "";
            code.hidden = !details?.code;
          }
          const description = target.querySelector("[data-project-description]");
          if (description) {
            description.toggleAttribute("data-i18n-ignore", !!details?.description);
            setMessageHtml(
              description,
              details?.description ? e(details.description) : messageHtml("projects.overviewHint", {}, t),
            );
          }
        }
        composer?.update();
        followAsset();
        return;
      }
      request?.abort();
      covers.close();
      assetPanel.close();
      modal.close();
      composer?.dispose();
      composer = null;
      epoch++;
      scope = project;
      tree = { projectId: scope, version: 0, nodes: [] };
      locale = document.documentElement.lang;
      host = target;
      query = "";
      limit = 24;
      assets = [];
      cursor = null;
      filter = "all";
      docsLoaded = false;
      assetsLoaded = false;
      contribute = false;
      paging = false;
      setMessageHtml(
        host,
        `<section class="creative-workspace ${scope === "personal" ? "" : "project-overview"}">${
          scope !== "personal"
            ? projectOverviewHeading(
                t,
                scope,
                projects().find((p) => p.id === scope),
              ) + projectOverviewTabs(t, scope)
            : `<header class="resource-heading"><div><h1 data-creative-heading>${messageHtml("creative.myWork", {}, t)}</h1><p>${messageHtml("creative.createHint", {}, t)}</p></div><div class="creative-heading-actions"><button type="button" class="wb-button" data-creative-new>${codexIcon("plus")}${messageHtml("creative.new", {}, t)}</button></div></header>`
        }<div data-system-composer></div>${scope === "personal" ? `<div class="creative-list-heading"><h2 data-creative-library>${messageHtml("creative.recent", {}, t)}</h2><label class="resource-search">${codexIcon("search")}<input type="search" data-creative-search ${messageAttributes("placeholder", "creative.search", {}, t)} ${messageAttributes("aria-label", "creative.search", {}, t)}></label></div>` : `<div class="project-content-toolbar wb-form"><div data-project-filters></div><label class="wb-field"><span class="project-content-search-caption">${messageHtml("creative.search", {}, t)}</span><span class="wb-control-with-icon">${codexIcon("search")}<input type="search" data-creative-search ${messageAttributes("placeholder", "creative.search", {}, t)}></span></label><h2 class="sr-only" data-creative-library>${messageHtml("creative.content", {}, t)}</h2></div>`}<p role="status" data-creative-status></p><div class="creative-grid" data-creative-grid></div><button type="button" class="wb-button" data-creative-more hidden>${messageHtml("templates.loadMore", {}, t)}</button></section>`,
      );
      composer = mountComposer(
        host.querySelector<HTMLElement>("[data-system-composer]")!,
        scope,
        () => {
          if (host === target && scope === project) void refresh();
        },
        { activity: context === "personal" },
      );
      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.className = "wb-button";
      importButton.dataset.creativeImport = "";
      importButton.disabled = true;
      setMessageHtml(importButton, `${codexIcon("fileInput")}${messageHtml("creative.assetImport", {}, t)}`);
      host.querySelector(".creative-heading-actions")!.prepend(importButton);
      const search = host.querySelector<HTMLInputElement>("[data-creative-search]")!;
      localizeAttribute(search, "placeholder", "creative.assetSearchLoaded", {}, t);
      localizeAttribute(search, "aria-label", "creative.assetSearchLoaded", {}, t);
      const filters = document.createElement("nav"),
        retry = document.createElement("button");
      filters.className = "creative-filters";
      filters.setAttribute("aria-label", t("creative.assetContentType"));
      setMessageHtml(
        filters,
        (["all", "document", "image", "video", "slides", "web", "file", "trash"] as const)
          .map(
            (kind) =>
              `<button type="button" class="wb-button" data-creative-filter="${kind}" aria-pressed="${kind === "all"}">${messageHtml(kind === "trash" ? "creative.assetFileTrash" : `creative.${kind}`, {}, t)}</button>`,
          )
          .join(""),
      );
      retry.type = "button";
      retry.className = "wb-button";
      retry.dataset.creativeRetry = "";
      retry.hidden = true;
      setMessageHtml(retry, messageHtml("creative.retry", {}, t));
      const filterHost = host.querySelector("[data-project-filters]");
      if (filterHost) filterHost.append(filters);
      else host.querySelector("[data-creative-grid]")!.before(filters);
      host.querySelector("[data-creative-grid]")!.before(retry);
      host.onclick = (event) => {
        const b = (event.target as Element).closest<HTMLElement>("button");
        if (!b) return;
        if (b.hasAttribute("data-creative-import")) void assetAction("import");
        if (b.dataset.creativeAsset) void assetAction("read", b.dataset.creativeAsset);
        if (b.dataset.creativeCopyAsset) void assetAction("copy", b.dataset.creativeCopyAsset);
        if (b.hasAttribute("data-creative-retry")) void refresh();
        if (b.dataset.creativeFilter) {
          const previous = filter;
          filter = b.dataset.creativeFilter as CreativeFilter;
          limit = 24;
          if ((previous === "trash") !== (filter === "trash")) void refresh();
          else cards();
        }
        if (b.hasAttribute("data-creative-new")) void create().catch(() => void refresh());
        if (b.dataset.creativeOpen) open(b.dataset.creativeOpen);
        if (b.dataset.creativeCopy) {
          const doc = tree.nodes.find((n) => n.documentId === b.dataset.creativeCopy)?.document;
          if (doc) void copy(doc);
        }
        if (b.hasAttribute("data-creative-more")) {
          void more();
        }
      };
      host.oninput = (event) => {
        if ((event.target as Element).matches("[data-creative-search]")) {
          query = (event.target as HTMLInputElement).value;
          cards();
        }
      };
      void refresh();
      followAsset();
    },
    hide() {
      if (host) {
        host.onclick = null;
        host.oninput = null;
        host.onchange = null;
      }
      epoch++;
      covers.close();
      request?.abort();
      assetPanel.close();
      paging = false;
      host = null;
      composer?.dispose();
      composer = null;
      modal.close();
      followedAsset = "";
    },
  };
}
