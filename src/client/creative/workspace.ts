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
import {
  projectCreationBody,
  projectCreationPath,
  projectOverviewHeading,
  updateProjectHeading,
} from "./project-view.js";

import { projectAssetKind, projectGallery, projectGalleryEmpty, projectGalleryLabel } from "./project-gallery.js";
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
    followedAsset = "",
    selectedAsset = "",
    catalogScroll = 0;
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
  let composerExpanded = false;
  let composer: ReturnType<ComposerMount> | null = null;
  const modal = new DocumentModal(t, context === "personal" ? "creativeActionDialog" : "projectCreativeActionDialog"),
    assetPanel = new LazyCreativeAssetsPanel(t, context + "CreativeAssetsDialog", identity),
    assetReader = new LazyCreativeAssetsPanel(t, "projectAssetReaderActions", identity);
  const open = (id: string, edit = false) =>
    navigate(
      scope === "personal"
        ? "/documents?" + new URLSearchParams({ project: scope, document: id, ...(edit ? { edit: "1" } : {}) })
        : projectCreationPath(scope, "document", id, edit),
    );
  function selectedCategory(): CreativeFilter {
    const kind = new URL(location.href).searchParams.get("kind");
    return (["image", "slides", "web", "video", "file", "trash"].find((item) => item === kind) ||
      "all") as CreativeFilter;
  }
  function notice(text: string, failed = false) {
    const el = host?.querySelector<HTMLElement>("[data-creative-status]");
    if (el) {
      el.textContent = text;
      el.dataset.error = String(failed);
    }
  }
  function assetPath(id?: string) {
    const url = new URL(projectCreationPath(scope, filter), location.origin);
    if (id) url.searchParams.set("asset", id);
    return url.pathname + url.search;
  }
  function followAsset() {
    if (!host) return;
    const params = new URL(location.href).searchParams,
      id = params.get("asset"),
      version = params.get("assetVersion") || undefined;
    const gallery = host.querySelector<HTMLElement>("[data-project-gallery]");
    if (!gallery) {
      if (id) {
        const key = JSON.stringify([scope, id, version]);
        if (key === followedAsset) return;
        followedAsset = key;
        const project = scope;
        void assetPanel
          .follow(
            project,
            id,
            async () => {
              if (project === scope && host) await refresh();
            },
            version,
          )
          .catch(() => notice(t("documents.unavailable"), true));
      } else if (followedAsset) {
        followedAsset = "";
        assetPanel.close();
      }
      return;
    }
    const reader = gallery.querySelector<HTMLElement>("[data-project-asset-reader]")!;
    const scroller = gallery.closest<HTMLElement>(".workbench-view");
    if (!id || filter === "trash") {
      if (!selectedAsset) return;
      const previous = selectedAsset;
      selectedAsset = followedAsset = "";
      assetReader.close();
      gallery.removeAttribute("data-open");
      reader.hidden = true;
      reader.querySelector("[data-project-asset-content]")!.replaceChildren();
      reader.querySelector("[data-project-asset-commands]")!.replaceChildren();
      cards();
      if (scroller) scroller.scrollTop = catalogScroll;
      const source = gallery.querySelector<HTMLElement>('[data-creative-asset="' + CSS.escape(previous) + '"]');
      (source || gallery.querySelector<HTMLElement>("[data-creative-search]"))?.focus({ preventScroll: true });
      return;
    }
    const project = scope,
      key = JSON.stringify([project, id, version]);
    if (key === followedAsset) return;
    if (!selectedAsset) catalogScroll = scroller?.scrollTop ?? 0;
    selectedAsset = id;
    followedAsset = key;
    const existing = assets.find((asset) => asset.id === id);
    const title = reader.querySelector<HTMLElement>("[data-project-asset-title]")!;
    title.textContent = existing?.title || t("creative.assetOpening");
    title.title = title.textContent;
    reader.dataset.assetKind = existing?.kind || "";
    gallery.dataset.open = "";
    reader.hidden = false;
    cards();
    if (scroller) scroller.scrollTop = 0;
    reader.querySelector<HTMLElement>("[data-project-asset-close]")?.focus({ preventScroll: true });
    const surface = reader.querySelector<HTMLElement>("[data-project-asset-content]")!;
    const commands = reader.querySelector<HTMLElement>("[data-project-asset-commands]")!;
    void assetReader
      .readInline(
        { project, id, title: title.textContent },
        surface,
        title,
        commands,
        async () => {
          if (host?.contains(reader) && followedAsset === key) {
            navigate(assetPath());
            await refresh();
          }
        },
        version,
      )
      .then((asset) => {
        if (asset && followedAsset === key) reader.dataset.assetKind = asset.kind;
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
    const grid = host.querySelector<HTMLElement>("[data-creative-grid]")!;
    const layout =
      scope === "personal" || (!selectedAsset && (filter === "image" || filter === "slides")) ? "tiles" : "rows";
    grid.dataset.galleryLayout = layout;
    grid.dataset.galleryCategory = filter;
    const status =
      !docsLoaded || !assetsLoaded
        ? "documents.loading"
        : failed
          ? "creative.assetLoadFailed"
          : cursor
            ? "creative.assetMoreAvailable"
            : query
              ? "creative.assetNoMatches"
              : "";
    setMessageHtml(
      grid,
      creativeCards(t, list.slice(0, limit), scope === "personal", layout, selectedAsset) ||
        (scope !== "personal" && capabilitiesLoaded && !status
          ? projectGalleryEmpty(t, filter, contribute && originals)
          : `<p class="resource-empty">${e(t(status || (filter === "trash" ? "creative.assetTrashEmpty" : "creative.empty")))}</p>`),
    );
    covers.render(grid);
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
    host.querySelector<HTMLElement>("[data-system-composer]")!.hidden =
      filter === "trash" || (scope !== "personal" && (filter !== "all" || !composerExpanded));
    const projectMenu = host.querySelector<HTMLElement>(".project-create-menu");
    if (projectMenu) projectMenu.hidden = filter !== "all";
    const upload = host.querySelector<HTMLButtonElement>(".project-gallery-upload");
    if (upload) {
      upload.hidden = !projectAssetKind(filter) || !originals;
      upload.disabled = !capabilitiesLoaded || !contribute;
    }
    const trash = host.querySelector<HTMLAnchorElement>("[data-project-trash]");
    if (trash) trash.hidden = filter !== "all" || !originals || Boolean(selectedAsset);
    host.querySelector("[data-creative-library]")!.textContent = t(
      filter === "trash"
        ? "creative.assetFileTrash"
        : scope === "personal"
          ? "creative.assetLibrary"
          : projectGalleryLabel(filter),
    );
    for (const control of host.querySelectorAll<HTMLElement>("[data-creative-filter]")) {
      const selected = control.dataset.creativeFilter === filter;
      const unavailable = ["slides", "web", "trash"].includes(control.dataset.creativeFilter ?? "") && !originals;
      if (control instanceof HTMLAnchorElement) {
        if (selected) control.setAttribute("aria-current", "page");
        else control.removeAttribute("aria-current");
        control.hidden = false;
      } else {
        control.setAttribute("aria-pressed", String(selected));
        control.hidden =
          unavailable ||
          (["slides", "web", "trash"].includes(control.dataset.creativeFilter ?? "") && !capabilitiesLoaded);
      }
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
    const assetKind = scope === "personal" ? undefined : projectAssetKind(filter);
    const skipTree = filter === "trash" || Boolean(assetKind);
    if (skipTree) readAhead?.cancel();
    const prepared = skipTree ? null : readAhead?.take(project);
    request = prepared?.controller ?? new AbortController();
    const signal = request.signal;
    docsLoaded = skipTree;
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
      skipTree
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
      (prepared?.assets ?? creativeAssetsApi.list(project, undefined, signal, state, assetKind))
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
        scope === "personal" ? undefined : projectAssetKind(filter),
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
    const asset = assets.find((candidate) => candidate.id === id);
    if (action === "read" && asset?.state === "saved" && scope !== "personal") {
      navigate(assetPath(asset.id));
      return;
    }
    const project = scope,
      surface = host;
    notice(t("documents.loading"));
    try {
      await assetPanel.open(
        action,
        project,
        asset,
        async () => {
          if (host === surface && project === scope) await refresh();
        },
        action === "import" && scope !== "personal" ? projectAssetKind(filter) : undefined,
      );
    } catch {
      if (host === surface && project === scope) notice(t("documents.unavailable"), true);
      return;
    }
    if (host === surface && project === scope) notice("");
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
        if (project !== "personal") {
          const details = projects().find((item) => item.id === project);
          if (details) updateProjectHeading(target, details.name);
          for (const menu of target.querySelectorAll<HTMLDetailsElement>("details[open]")) {
            if (menu.matches(".project-create-menu")) menu.open = false;
          }
          const next = selectedCategory();
          if (next !== filter) {
            filter = next;
            const picker = target.querySelector<HTMLSelectElement>("#projectCreationCategory");
            if (picker) {
              for (const option of picker.querySelectorAll<HTMLOptionElement>("option[data-legacy]"))
                option.hidden = option.value !== next;
              picker.value = next;
            }
            limit = 24;
            void refresh();
          }
        }
        composer?.update();
        followAsset();
        return;
      }
      request?.abort();
      covers.close();
      assetPanel.close();
      assetReader.close();
      selectedAsset = followedAsset = "";
      catalogScroll = 0;
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
      filter = project === "personal" ? "all" : selectedCategory();
      composerExpanded = false;
      docsLoaded = false;
      assetsLoaded = false;
      contribute = false;
      paging = false;
      const newButton = `<button type="button" class="wb-button" data-creative-new>${codexIcon("plus")}${messageHtml(scope === "personal" ? "creative.new" : "documents.newDocument", {}, t)}</button>`;
      const heading =
        scope === "personal"
          ? `<header class="resource-heading"><div><h1 data-creative-heading>${messageHtml("creative.myWork", {}, t)}</h1><p>${messageHtml("creative.createHint", {}, t)}</p></div><div class="creative-heading-actions">${newButton}</div></header>`
          : projectOverviewHeading(
              t,
              scope,
              projects().find((p) => p.id === scope),
            );
      const projectActions = `<div class="project-creation-actions"><details class="project-create-menu"><summary class="wb-button primary">${codexIcon("plus")}${messageHtml("creative.new", {}, t)}</summary><div class="creative-heading-actions"><button type="button" class="wb-button" data-project-compose>${messageHtml("creation.trigger", {}, t)}</button>${newButton}</div></details><button type="button" class="wb-button primary project-gallery-upload" data-project-import hidden ${messageAttributes("aria-label", "creative.assetImport", {}, t)}>${codexIcon("fileInput")}<span>${messageHtml("creative.assetImport", {}, t)}</span></button></div>`;
      const personalList = `<div class="creative-list-heading"><h2 data-creative-library>${messageHtml("creative.recent", {}, t)}</h2><label class="resource-search">${codexIcon("search")}<input type="search" data-creative-search ${messageAttributes("placeholder", "creative.search", {}, t)} ${messageAttributes("aria-label", "creative.search", {}, t)}></label></div><p role="status" data-creative-status></p><div class="creative-grid" data-creative-grid></div><button type="button" class="wb-button" data-creative-more hidden>${messageHtml("templates.loadMore", {}, t)}</button>`;
      const content =
        scope === "personal"
          ? `<div data-system-composer></div>${personalList}`
          : projectCreationBody(
              t,
              scope,
              filter,
              projectActions,
              `<div data-system-composer hidden></div>${projectGallery(t, scope)}`,
            );
      setMessageHtml(
        host,
        `<section class="creative-workspace ${scope === "personal" ? "" : "project-overview project-creation-gallery"}">${heading}${content}</section>`,
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
      if (scope === "personal") host.querySelector("[data-creative-grid]")!.before(filters);
      host.querySelector("[data-creative-grid]")!.before(retry);
      host.onclick = (event) => {
        const b = (event.target as Element).closest<HTMLElement>("button");
        if (!b) return;
        const menu = b.closest<HTMLDetailsElement>(".project-create-menu");
        if (menu) {
          menu.open = false;
          menu.querySelector("summary")?.focus();
        }
        if (b.hasAttribute("data-project-compose")) {
          composerExpanded = true;
          const pane = host?.querySelector<HTMLElement>("[data-system-composer]");
          if (pane) pane.hidden = false;
          composer?.update();
          const prompt = pane?.querySelector<HTMLElement>("textarea");
          if (prompt) prompt.focus();
          else pane?.scrollIntoView({ block: "nearest" });
        }
        if (b.hasAttribute("data-project-asset-close")) navigate(assetPath());
        if (b.hasAttribute("data-creative-import") || b.hasAttribute("data-project-import")) void assetAction("import");
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
      host.querySelector("[data-project-asset-reader]")?.addEventListener("keydown", (event) => {
        if (event instanceof KeyboardEvent && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          navigate(assetPath());
        }
      });
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
      assetReader.close();
      selectedAsset = "";
      paging = false;
      host = null;
      composer?.dispose();
      composer = null;
      modal.close();
      followedAsset = "";
    },
  };
}
