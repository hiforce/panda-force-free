import type { Translate } from "../../shared/i18n/messages.js";
import type { ProjectDocumentTree } from "../../shared/documents/navigation.js";
import type { ContentProject } from "../creative/workspace.js";
import { projectOverviewHeading, projectOverviewTabs } from "../creative/project-view.js";
import { documentTreeApi } from "../documents/authoring/tree-api.js";
import { codexIcon } from "../codex-icons.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, messageHtml as m, messageAttributes as attrs, getBrowserI18n } from "../i18n.js";

/** Directory discovery stays in the project; the existing authoring workspace owns editing and tree mutations. */
export function createProjectDocumentsView(
  t: Translate,
  projects: () => ContentProject[],
  navigate: (path: string) => void,
) {
  let host: HTMLElement | null = null,
    project = "",
    request: AbortController | null = null,
    loaded = false,
    epoch = 0;
  let tree: ProjectDocumentTree = { projectId: "", version: 0, nodes: [] };
  const states = new Map<string, { query: string; collapsed: Set<string> }>();
  const state = () => {
    let value = states.get(project);
    if (!value) {
      value = { query: "", collapsed: new Set() };
      states.set(project, value);
    }
    return value;
  };
  function rows() {
    if (!host || !loaded) return;
    const current = state(),
      query = current.query.trim().toLocaleLowerCase(),
      byId = new Map(tree.nodes.map((n) => [n.documentId, n]));
    const included = new Set<string>();
    for (const node of tree.nodes)
      if (!query || node.document.title.toLocaleLowerCase().includes(query)) {
        let id: string | null = node.documentId;
        while (id && !included.has(id)) {
          included.add(id);
          id = byId.get(id)?.parentId || null;
        }
      }
    const children = new Map<string | null, typeof tree.nodes>();
    for (const node of tree.nodes) {
      const list = children.get(node.parentId) || [];
      list.push(node);
      children.set(node.parentId, list);
    }
    const visible: { node: (typeof tree.nodes)[number]; depth: number }[] = [],
      seen = new Set<string>();
    function visit(parent: string | null, depth: number) {
      for (const node of (children.get(parent) || []).sort((a, b) => a.position - b.position)) {
        if (seen.has(node.documentId) || !included.has(node.documentId)) continue;
        seen.add(node.documentId);
        visible.push({ node, depth });
        if (query || !current.collapsed.has(node.documentId)) visit(node.documentId, depth + 1);
      }
    }
    visit(null, 0);
    const list = host.querySelector<HTMLElement>("[data-project-documents]")!;
    setMessageHtml(
      list,
      visible
        .map(
          ({ node, depth }) =>
            `<article class="project-document-row" style="--project-document-depth:${Math.min(depth, 8)}">${children.has(node.documentId) ? `<button type="button" class="icon-button" data-directory-toggle="${e(node.documentId)}" aria-expanded="${!current.collapsed.has(node.documentId)}" ${attrs("aria-label", "documents.directoryToggle", {}, t)}>${codexIcon(current.collapsed.has(node.documentId) ? "chevronRight" : "chevronDown")}</button>` : '<span class="project-document-indent" aria-hidden="true"></span>'}<button type="button" class="project-document-open" data-directory-open="${e(node.documentId)}">${codexIcon("file")}<span data-i18n-ignore>${e(node.document.title)}</span></button><span class="project-document-version">v${node.document.revision}</span><time datetime="${new Date(node.document.updatedAt).toISOString()}">${e(getBrowserI18n().format.dateTime(node.document.updatedAt, { dateStyle: "medium" }))}</time></article>`,
        )
        .join("") ||
        `<div class="project-directory-empty">${codexIcon(query ? "search" : "file")}<h2>${m(query ? "projects.noDocumentsMatchTitle" : "projects.noDocuments", {}, t)}</h2><p>${m(query ? "projects.noDocumentsMatch" : "projects.directoryEmptyHint", {}, t)}</p>${!query ? `<a class="wb-button primary" href="/project?id=${encodeURIComponent(project)}">${m("projects.aiCreate", {}, t)}</a>` : ""}</div>`,
    );
  }
  async function load() {
    request?.abort();
    request = new AbortController();
    const signal = request.signal,
      generation = ++epoch;
    const status = host!.querySelector<HTMLElement>("[data-project-directory-status]")!;
    status.textContent = t("documents.loading");
    host!.querySelector("[data-project-documents]")!.setAttribute("aria-busy", "true");
    try {
      const value = await documentTreeApi.read(project, signal);
      if (generation !== epoch || !host) return;
      tree = value;
      loaded = true;
      rows();
      status.textContent = "";
    } catch {
      if (generation === epoch && host)
        setMessageHtml(
          status,
          `${m("documents.unavailable", {}, t)} <button type="button" class="wb-button" data-directory-retry>${m("common.retry", {}, t)}</button>`,
        );
    } finally {
      if (generation === epoch && host)
        host.querySelector("[data-project-documents]")!.setAttribute("aria-busy", "false");
    }
  }
  getBrowserI18n().subscribe(() => {
    if (host) rows();
  });
  return {
    show(target: HTMLElement, id = "") {
      if (host === target && project === id && target.querySelector(".project-documents-view")) return;
      request?.abort();
      host = target;
      project = id;
      loaded = false;
      tree = { projectId: id, version: 0, nodes: [] };
      const home = "/project?id=" + encodeURIComponent(id),
        editor = "/documents?project=" + encodeURIComponent(id);
      setMessageHtml(
        host,
        `<section class="project-overview project-documents-view">${projectOverviewHeading(
          t,
          id,
          projects().find((p) => p.id === id),
          `<a class="wb-button" href="${editor}">${m("projects.manageDirectory", {}, t)}</a><a class="wb-button primary" href="${home}">${m("projects.aiCreate", {}, t)}</a>`,
        )}${projectOverviewTabs(t, id, "documents")}<header class="project-section-heading"><div><h2>${m("documents.directory", {}, t)}</h2><p>${m("projects.directoryHint", {}, t)}</p></div></header><div class="wb-form project-document-search"><label class="wb-field"><span class="sr-only">${m("documents.searchTree", {}, t)}</span><span class="wb-control-with-icon">${codexIcon("search")}<input type="search" data-project-document-search ${attrs("placeholder", "documents.searchTree", {}, t)} value="${e(state().query)}"></span></label></div><p role="status" data-project-directory-status></p><div data-project-documents class="project-document-list"></div></section>`,
      );
      host.onclick = (event) => {
        const b = (event.target as Element).closest<HTMLElement>("button");
        if (!b) return;
        if (b.dataset.directoryOpen) navigate(editor + "&document=" + encodeURIComponent(b.dataset.directoryOpen));
        if (b.hasAttribute("data-directory-retry")) void load();
        if (b.dataset.directoryToggle) {
          const set = state().collapsed,
            id = b.dataset.directoryToggle;
          set.has(id) ? set.delete(id) : set.add(id);
          rows();
          host?.querySelector<HTMLButtonElement>(`[data-directory-toggle="${CSS.escape(id)}"]`)?.focus();
        }
      };
      host.oninput = (event) => {
        if ((event.target as Element).matches("[data-project-document-search]")) {
          state().query = (event.target as HTMLInputElement).value;
          rows();
        }
      };
      void load();
    },
    hide() {
      epoch++;
      request?.abort();
      if (host) {
        host.onclick = null;
        host.oninput = null;
      }
      host = null;
    },
  };
}
