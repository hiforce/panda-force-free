import { createManagedTemplateDetail } from "./detail.js";
import { loadTemplateDetails } from "./lazy-details.js";
import { coverFailed } from "./covers.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { TemplateCatalogPage, ManagedTemplate } from "../../shared/templates/catalog.js";
import type { TemplateSection } from "../../shared/templates/sections.js";
import type { TemplateDomain } from "../../shared/templates/domain.js";
import type { TemplateCommands } from "./command-port.js";
import {
  setMessageHtml,
  errorText,
  localizeAttribute,
  getBrowserI18n,
  setOpaqueText,
  setOpaqueAttribute,
} from "../i18n.js";
import { presentationLabel } from "../presentation-labels.js";

import { PluginApiError } from "../plugins/api.js";
import { TemplateCatalogCache } from "./catalog-cache.js";
import { loadTemplateCommands } from "./lazy-commands.js";
import { loadWritingSkillAuthoring, prepareWritingSkillEditor } from "./lazy-authoring.js";
import type { WritingSkillAuthoring } from "./authoring-port.js";
import { managedTemplatesApi as api } from "./api.js";
import { loadTemplatePreviewCovers } from "../template-previews/cards.js";
import { managerFrame, managerCard, managerEmpty, templateState } from "./views.js";
import type { SkillWorkspaceActions } from "../skill-workspace/ports.js";

export interface TemplateManagerScope {
  section?: TemplateSection;
  domain?: TemplateDomain;
  engine?: string;
  format?: string;
  collection?: string;
  title?: string;
  all?: boolean;
}

/** Owns one gallery and query generation. Native commands, details and draft editing have separate lifetimes. */
export function createTemplateManager(t: Translate, identity: string | undefined) {
  let host: HTMLElement | null = null,
    epoch = 0,
    busy = false,
    cursor: string | null = null,
    entries: ManagedTemplate[] = [],
    total = 0;
  const cache = new TemplateCatalogCache();
  const filtersByScope = new Map<string, { search: string; type: string; state: string }>();
  const scopeKey = () =>
    JSON.stringify([
      scope.section || "",
      scope.domain || "",
      scope.collection || "",
      scope.engine || "",
      scope.format || "",
      Boolean(workspace),
    ]);
  function rememberFilters() {
    if (!host) return;
    filtersByScope.set(scopeKey(), {
      search: host.querySelector<HTMLInputElement>("[data-template-search]")?.value || "",
      type: host.querySelector<HTMLSelectElement>("[data-template-type]")?.value || "",
      state: host.querySelector<HTMLSelectElement>("[data-template-state]")?.value || "all",
    });
    if (filtersByScope.size > 24) filtersByScope.delete(filtersByScope.keys().next().value!);
  }
  let read: AbortController | null = null;
  let scope: TemplateManagerScope = {};
  let workspace: SkillWorkspaceActions | null = null,
    itemRead: AbortController | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  function closeMenu(event?: Event) {
    if (event?.target instanceof Node && host?.querySelector("[data-template-menu]")?.contains(event.target)) return;
    host?.querySelector<HTMLDetailsElement>("[data-template-menu]")?.removeAttribute("open");
  }
  let commands: TemplateCommands | null = null;
  let authoring: WritingSkillAuthoring | null = null;
  let preparingEditor = false,
    preparingAuthoring = false;
  const prepareEditor = (event: Event) => {
    if (preparingEditor || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('[data-template-action="article"]');
    if (!button || button.disabled || button.hidden) return;
    preparingEditor = true;
    void prepareWritingSkillEditor().catch(() => {
      preparingEditor = false;
    });
  };
  let detail: ReturnType<typeof createManagedTemplateDetail> | null = null;
  async function getCommands() {
    const generation = epoch,
      target = host;
    notice(t("plugins.working"));
    const runtime = await loadTemplateCommands();
    if (generation !== epoch || host !== target || !target?.isConnected) return null;
    commands ??= runtime.createTemplateCommands(t, identity, {
      refresh: () => {
        cache.clear();
        void refresh();
      },
      notice,
      creationStatus,
    });
    notice("");
    return commands;
  }
  async function getAuthoring() {
    const generation = epoch,
      target = host;
    notice(t("plugins.working"));
    const runtime = await loadWritingSkillAuthoring();
    if (generation !== epoch || host !== target || !target?.isConnected) return null;
    authoring ??= runtime.createTemplateAuthoring(
      t,
      identity || "local",
      () => {
        cache.clear();
        void refresh();
      },
      (error) =>
        notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        ),
      creationStatus,
    );
    notice("");
    return authoring;
  }
  async function command(action: string, item?: ManagedTemplate) {
    if (action === "detail" && item) {
      detail ??= createManagedTemplateDetail(
        t,
        async () =>
          (await loadTemplateDetails()).templateDetailAdapters(
            t,
            identity,
            getCommands,
            getAuthoring,
            loadTemplateCommands,
          ),
        () => {
          cache.clear();
          void refresh();
        },
        () => workspace,
      );
      await detail.open(item);
      return;
    }
    const generation = epoch;
    const writing = action === "article" || action === "article-drafts";
    if (writing && preparingAuthoring) return;
    if (writing) {
      preparingAuthoring = true;
      creationStatus(true);
    }
    try {
      if (writing) {
        const current = await getAuthoring();
        if (action === "article") await current?.create();
        else current?.library();
      } else {
        const current = await getCommands();
        await current?.run(action);
      }
    } catch (error) {
      if (generation === epoch)
        notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        );
    } finally {
      if (writing) {
        preparingAuthoring = false;
        creationStatus(authoring?.creating || false);
      }
    }
  }
  const get = <T extends HTMLElement>(selector: string) => host!.querySelector<T>(selector)!;
  function creationStatus(busy: boolean) {
    if (!host) return;
    const active = busy || preparingAuthoring,
      button = get<HTMLButtonElement>('[data-template-action="article"]');
    button.disabled = active;
    button.setAttribute("aria-busy", String(active));
    get("[data-template-creation-notice]").textContent = active ? t("plugins.working") : "";
  }
  function notice(text: string, failed = false) {
    if (!host) return;
    const node = get("[data-template-notice]");
    node.textContent = text;
    node.dataset.error = String(failed);
  }
  function controls() {
    if (!host) return;
    host.setAttribute("aria-busy", String(busy));
    for (const button of host.querySelectorAll<HTMLButtonElement>(
      '[data-template-action="more"],[data-template-action="refresh"]',
    ))
      button.disabled = busy;
    get("[data-template-action=more]").hidden = !cursor;
  }
  async function refresh(more = false, cached = false) {
    if (!host || (more && (busy || !cursor))) return;
    if (debounce) clearTimeout(debounce);
    debounce = null;
    read?.abort();
    const request = new AbortController();
    read = request;
    const generation = ++epoch,
      target = host;
    busy = true;
    controls();
    notice(t("plugins.working"));
    const query = new URLSearchParams({
      limit: "24",
      view: "gallery",
      type: get<HTMLSelectElement>("[data-template-type]").value,
      state: get<HTMLSelectElement>("[data-template-state]").value,
      search: get<HTMLInputElement>("[data-template-search]").value,
      ...(workspace ? { order: "purpose" } : {}),
    });
    for (const key of ["section", "domain", "engine", "format", "collection"] as const)
      if (scope[key] && !(key === "section" && scope.collection)) query.set(key, scope[key]!);
    if (more && cursor) query.set("cursor", cursor);
    const draw = (page: TemplateCatalogPage) => {
      entries = more ? [...entries, ...page.templates] : page.templates;
      total = page.total;
      cursor = page.nextCursor;
      const filtered = ["search", "type", "state"].some((key) => {
        const value = query.get(key);
        return value && value !== "all";
      });
      setMessageHtml(
        get("[data-template-grid]"),
        entries.length
          ? entries.map((item) => managerCard(t, item, workspace ? workspace.isPinned(item.key) : undefined)).join("")
          : managerEmpty(t, filtered, scope.domain),
      );
      void loadTemplatePreviewCovers(
        get("[data-template-grid]"),
        entries,
        () => generation === epoch && target === host,
      );
      get("[data-template-total]").textContent = t(
        scope.domain === "publishing" ? "templates.resourceCount" : "templates.count",
        { shown: entries.length, total },
      );
      get("[data-template-total]").hidden = !entries.length;
      syncWorkspace();
    };
    const saved = cached && !more ? cache.read(query.toString()) : null;
    if (saved) {
      draw(saved);
      notice(t("templates.updating"));
    }
    try {
      const page = await api.list(query, request.signal);
      if (generation !== epoch || target !== host) return;
      if (!more) cache.write(query.toString(), page);
      draw(page);
      notice("");
    } catch (error) {
      if (generation === epoch) {
        if (error instanceof PluginApiError && [401, 403].includes(error.status)) {
          cache.clear();
          entries = [];
          cursor = null;
          get("[data-template-grid]").replaceChildren();
          get("[data-template-total]").hidden = true;
        }
        notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        );
      }
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  function syncWorkspace() {
    if (!host || !workspace) return;
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-template-action="pin"]')) {
      const pinned = workspace.isPinned(button.dataset.skillsPinKey!);
      button.setAttribute("aria-pressed", String(pinned));
      button.disabled = !workspace.ready();
      localizeAttribute(button, "aria-label", pinned ? "skillWorkspace.unpin" : "skillWorkspace.pin", undefined, t);
    }
    detail?.syncWorkspace();
  }
  getBrowserI18n().subscribe(() => {
    if (!host) return;
    const items = new Map(entries.map((item) => [item.key, item]));
    for (const card of host.querySelectorAll<HTMLButtonElement>(".template-card[data-template-key]")) {
      const item = items.get(card.dataset.templateKey!);
      if (!item) continue;
      const label = presentationLabel(t, item.label),
        state = templateState(t, item);
      setOpaqueText(card.querySelector("strong")!, label);
      setOpaqueText(card.querySelector(".template-card-description")!, presentationLabel(t, item.label, "description"));
      setOpaqueAttribute(card, "title", label);
      const status = card.querySelector(".template-state")!,
        description = state + " · " + item.reference.version;
      setOpaqueAttribute(status, "aria-label", description);
      setOpaqueAttribute(status, "title", description);
      const exceptional = card.querySelector(".template-card-status");
      if (exceptional) setOpaqueText(exceptional, state);
    }
    get("[data-template-total]").textContent = t(
      scope.domain === "publishing" ? "templates.resourceCount" : "templates.count",
      { shown: entries.length, total },
    );
    syncWorkspace();
  });
  return {
    setWorkspaceActions(value: SkillWorkspaceActions | null) {
      workspace = value;
    },
    syncWorkspace,
    reload() {
      cache.clear();
      return refresh();
    },
    async openItem(key: string) {
      if (!host) return;
      itemRead?.abort();
      const current = new AbortController(),
        generation = epoch,
        target = host;
      itemRead = current;
      const timer = setTimeout(() => current.abort(), 12000);
      notice(t("skillWorkspace.opening"));
      try {
        const item = await api.item(key, current.signal);
        if (itemRead !== current || generation !== epoch || target !== host) return;
        await command("detail", item);
        if (target === host) notice("");
      } catch (error) {
        if (itemRead === current && generation === epoch && target === host)
          notice(
            errorText(error instanceof PluginApiError ? error.payload : null, t, "skillWorkspace.skillUnavailable"),
            true,
          );
      } finally {
        clearTimeout(timer);
        if (itemRead === current) itemRead = null;
      }
    },
    show(target: HTMLElement, selection: TemplateManagerScope = {}) {
      scope = selection;
      host = target;
      host.addEventListener("error", coverFailed, true);
      host.classList.add("template-manager");
      setMessageHtml(host, managerFrame(t, scope.domain));
      if (scope.domain === "skills") get('[data-template-action="drafts"]').hidden = true;
      const remembered = filtersByScope.get(scopeKey());
      if (remembered) {
        get<HTMLInputElement>("[data-template-search]").value = remembered.search;
        get<HTMLSelectElement>("[data-template-type]").value = remembered.type;
        get<HTMLSelectElement>("[data-template-state]").value = remembered.state;
      }
      if (scope.section) {
        const title = host.querySelector("h1")!;
        host.querySelector(".resource-heading p")!.textContent = t(
          scope.section === "site"
            ? "creative.siteThemeHint"
            : scope.section === "channel"
              ? "creative.channelLayoutHint"
              : "creative.skillHint",
        );
        title.textContent = t(
          scope.section === "channel"
            ? "creative.channelTemplates"
            : `creative.skillTitle${({ writing: "Writing", research: "Research", slides: "Slides", image: "Image", web: "Web", video: "Video", site: "Site" } as const)[scope.section]}`,
        );
        host.querySelector("[data-template-type]")!.setAttribute("hidden", "");
        for (const action of ["article", "article-drafts"])
          get(`[data-template-action="${action}"]`).hidden = scope.section !== "writing";
        get('[data-template-action="drafts"]').hidden = !["site", "channel"].includes(scope.section);
      }
      if (scope.title) host.querySelector("h1")!.textContent = scope.title;
      host.onkeydown = (event) => {
        if (event.key === "Escape" && host?.querySelector("[data-template-menu][open]")) {
          closeMenu();
          host.querySelector<HTMLElement>("[data-template-menu] summary")?.focus();
          event.stopPropagation();
        }
      };
      document.addEventListener("click", closeMenu);
      host.addEventListener("pointerover", prepareEditor);
      host.addEventListener("pointerdown", prepareEditor);
      host.addEventListener("focusin", prepareEditor);
      creationStatus(authoring?.creating || false);
      host.onclick = (event) => {
        const button =
          event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-template-action]") : null;
        if (!button || button.disabled) return;
        closeMenu();
        const action = button.dataset.templateAction;
        if (action === "pin" && workspace) {
          const item = entries.find((entry) => entry.key === button.dataset.skillsPinKey);
          if (item) void workspace.togglePin(item).catch(() => {});
          return;
        }
        if (action === "refresh") void refresh();
        if (action === "more") void refresh(true);
        if (action === "import") void command(action);
        if (action === "source-import") void command(action);
        if (action === "drafts") void command(action);
        if (action === "article") void command(action);
        if (action === "article-drafts") void command(action);
        if (action === "clear-filters") {
          get<HTMLInputElement>("[data-template-search]").value = "";
          get<HTMLSelectElement>("[data-template-type]").value = "";
          get<HTMLSelectElement>("[data-template-state]").value = "all";
          void refresh();
        }
        if (action === "detail") {
          const item = entries.find((entry) => entry.key === button.dataset.templateKey);
          if (item) void command(action, item);
        }
      };
      host.oninput = (event) => {
        if (event.target instanceof Element && event.target.matches("[data-template-search]")) {
          epoch++;
          read?.abort();
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void refresh(), 220);
        }
      };
      host.onchange = (event) => {
        if (event.target instanceof Element && event.target.matches("[data-template-type],[data-template-state]"))
          void refresh();
      };
      void refresh(false, true);
    },
    hide() {
      rememberFilters();
      itemRead?.abort();
      read?.abort();
      document.removeEventListener("click", closeMenu);
      if (host) {
        host.onkeydown = null;
        host.removeEventListener("error", coverFailed, true);
        host.removeEventListener("pointerover", prepareEditor);
        host.removeEventListener("pointerdown", prepareEditor);
        host.removeEventListener("focusin", prepareEditor);
      }
      epoch++;
      if (debounce) clearTimeout(debounce);
      debounce = null;
      host = null;
      entries = [];
      cursor = null;
      busy = false;
      detail?.close();
      commands?.close();
      authoring?.close();
    },
  };
}
