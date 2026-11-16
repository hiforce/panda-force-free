import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentRecord, DocumentSpace } from "../../shared/documents/contracts.js";
import { setMessageHtml, messageHtml, errorText } from "../i18n.js";

import { documentApi, DocumentApiError } from "./api.js";
import { DocumentDrafts } from "./drafts.js";
import { DocumentDialogs } from "./dialogs.js";
import { DocumentModal } from "./modal.js";
import { DocumentResources } from "./resources.js";
import { DocumentEditor, type DocumentPublicationActions } from "./editor.js";
import { frame, directory, empty, action } from "./views.js";
import { SourceProfileDialog } from "./source-profile.js";
import { SourceThemeDialog } from "./source-theme.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";

/** Project navigation and document discovery are separate from revision editing and publication. */
export function createDocumentWorkspace({
  t,
  identityKey,
  publishing,
  building,
  delivery,
  packages,
}: {
  t: Translate;
  identityKey: string;
  publishing: DocumentPublicationActions;
  building: { open(space: DocumentSpace): void; close(): void };
  delivery: { open(space: DocumentSpace): void; close(): void };
  packages?: { open(value?: PluginPackage): void; close(): void };
}) {
  const root = document.createElement("section");
  root.className = "documents-workspace";
  const modal = new DocumentModal(t);
  const dialogs = new DocumentDialogs(t, modal);
  const sourceProfile = new SourceProfileDialog(t, modal);
  const sourceTheme = new SourceThemeDialog(t, modal);
  const editor = new DocumentEditor(
    t,
    new DocumentDrafts(identityKey),
    dialogs,
    (record) => {
      notice("");
      records = records.map((old) => (old.id === record.id ? record : old));
      renderTree();
    },
    report,
    new DocumentResources(t, modal),
    publishing,
  );
  let projectId = "",
    spaces: DocumentSpace[] = [],
    spaceId = "",
    records: DocumentRecord[] = [];
  let epoch = 0,
    listEpoch = 0,
    offset: number | null = null,
    query = "",
    searching: ReturnType<typeof setTimeout> | undefined;
  const collapsed = new Set<string>();
  function currentSpace() {
    return spaces.find((s) => s.id === spaceId);
  }
  function notice(text: string, error = false) {
    const el = root.querySelector<HTMLElement>("#documentNotice");
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
    el.dataset.error = String(error);
  }
  function report(error: unknown) {
    notice(errorText(error instanceof DocumentApiError ? error.payload : null, t, "documents.unavailable"), true);
  }
  function renderTree() {
    const tree = root.querySelector<HTMLElement>("#documentTree");
    if (!tree) return;
    setMessageHtml(tree, directory(t, records, editor.id, offset !== null, collapsed));
    tree.querySelectorAll<HTMLDetailsElement>("details").forEach((details) =>
      details.addEventListener("toggle", () => {
        if (!details.isConnected || !tree.contains(details)) return;
        if (details.open) collapsed.delete(details.dataset.directory!);
        else collapsed.add(details.dataset.directory!);
      }),
    );
  }
  async function list(append = false) {
    const generation = ++listEpoch,
      view = epoch;
    const page = await documentApi.list(spaceId, query, append ? offset || 0 : 0);
    if (generation !== listEpoch || view !== epoch) return;
    records = append ? [...records, ...page.documents] : page.documents;
    offset = page.nextOffset;
    renderTree();
  }
  function draw() {
    editor.detach();
    setMessageHtml(root, frame(t, projectId, spaces, spaceId, !!packages));
    if (!spaces.length) {
      setMessageHtml(root.querySelector(".documents-layout"), empty(t, "documents.noSpaces", "documents.noSpacesHint"));
      root.querySelector<HTMLElement>(".documents-spaces")!.hidden = true;
      return;
    }
    editor.mount(root.querySelector<HTMLElement>("#documentEditor")!);
    const space = currentSpace()!;
    setMessageHtml(
      root.querySelector("#documentSourceInfo"),
      messageHtml(space.sourceMode === "external" ? "documents.readOnlySource" : "documents.managed", undefined, t),
    );
    setMessageHtml(
      root.querySelector("#documentSpaceActions"),
      action(t, "documents.chooseTheme", "theme") +
        (space.engine === "hexo" && space.sourceMode === "external"
          ? action(t, "documents.sourceSettings", "source-profile")
          : "") +
        (packages && space.engine === "hexo" && space.sourceMode === "external"
          ? action(t, "documents.packageSourceTheme", "source-theme")
          : "") +
        action(t, "builds.open", "build") +
        action(t, "delivery.open", "delivery") +
        (space.sourceMode === "external" ? action(t, "documents.refreshSource", "scan") : "") +
        action(t, "documents.newDocument", "new-document", "", true),
    );
    root.querySelector<HTMLInputElement>("#documentSearch")!.oninput = (event) => {
      query = (event.target as HTMLInputElement).value;
      listEpoch++;
      clearTimeout(searching);
      searching = setTimeout(() => void list().catch(report), 200);
    };
    root.querySelector<HTMLSelectElement>("#documentSpace")!.onchange = (event) => {
      void selectSpace((event.target as HTMLSelectElement).value).catch(report);
    };
  }
  async function selectSpace(id: string) {
    epoch++;
    listEpoch++;
    clearTimeout(searching);
    dialogs.close();
    publishing.close();
    building.close();
    delivery.close();
    packages?.close();
    spaceId = id;
    query = "";
    records = [];
    offset = null;
    collapsed.clear();
    draw();
    await list();
  }
  async function load(project: string) {
    const generation = ++epoch;
    listEpoch++;
    projectId = project;
    editor.detach();
    dialogs.close();
    publishing.close();
    building.close();
    delivery.close();
    packages?.close();
    setMessageHtml(root, empty(t, "documents.loading"));
    try {
      const result = await documentApi.spaces(project);
      if (generation !== epoch) return;
      spaces = result.spaces;
      spaceId = spaces[0]?.id || "";
      query = "";
      records = [];
      offset = null;
      draw();
      if (spaceId) await list();
    } catch (error) {
      if (generation !== epoch) return;
      setMessageHtml(root, frame(t, projectId, [], "", !!packages));
      report(error);
    }
  }
  async function act(trigger: HTMLButtonElement) {
    const name = trigger.dataset.docAction,
      generation = epoch;
    if (name === "packages") {
      packages?.open();
      return;
    }
    if (name === "select") {
      await editor.select(trigger.dataset.id!);
      if (generation === epoch) renderTree();
      return;
    }
    if (name === "more") {
      await list(true);
      return;
    }
    if (name === "new-space") {
      const result = await dialogs.space(projectId);
      if (!result || generation !== epoch) return;
      spaces.push(result);
      await selectSpace(result.id);
      return;
    }
    const space = currentSpace();
    if (!space) return;
    if (name === "theme") {
      const updated = await dialogs.theme(space);
      if (updated && generation === epoch) {
        spaces = spaces.map((item) => (item.id === updated.id ? updated : item));
        notice(t("documents.themeUpdated"));
      }
      return;
    }
    if (name === "source-profile") {
      const updated = await sourceProfile.open(space);
      if (updated && generation === epoch) {
        spaces = spaces.map((item) => (item.id === updated.id ? updated : item));
        notice(t("documents.sourceProfileUpdated"));
      }
      return;
    }
    if (name === "source-theme") {
      const value = await sourceTheme.open(space);
      if (value && generation === epoch) packages?.open(value);
      return;
    }
    if (name === "build") {
      building.open(space);
      return;
    }
    if (name === "delivery") {
      delivery.open(space);
      return;
    }
    if (name === "new-document") {
      const detail = await dialogs.create(space);
      if (!detail || generation !== epoch) return;
      editor.install(detail);
      await list();
      return;
    }
    if (name === "scan") {
      notice(t("documents.importingSource"));
      const selected = editor.id;
      const result = await documentApi.scan(space.id);
      if (generation !== epoch) return;
      const messages = [t("documents.importResult", result)];
      if (result.conflicts.length) messages.push(t("documents.importConflicts", { count: result.conflicts.length }));
      if (result.skipped.length) messages.push(t("documents.importSkipped", { count: result.skipped.length }));
      if (result.truncated) messages.push(t("documents.importTruncated"));
      if (result.assets) messages.push(t("documents.imageImportSummary", { count: result.assets.imported }));
      if (result.assets?.issuesTruncated) messages.push(t("documents.imageIssuesTruncated"));
      notice(messages.join(" "));
      await list();
      if (generation === epoch && selected && editor.id === selected) await editor.select(selected);
      if (generation === epoch && result.assets?.issues.length)
        await dialogs.importReport(result.assets.imported, result.assets.issues);
    }
  }
  root.addEventListener("click", (event) => {
    const trigger =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-doc-action]") : null;
    if (!trigger || trigger.disabled || trigger.closest("#documentEditor")) return;
    trigger.disabled = true;
    void act(trigger)
      .catch(report)
      .finally(() => {
        trigger.disabled = false;
      });
  });
  window.addEventListener("pagehide", () => editor.flush());
  return {
    show(host: HTMLElement, project: string) {
      if (root.parentElement === host && projectId === project) return;
      host.replaceChildren(root);
      void load(project);
    },
    hide() {
      epoch++;
      listEpoch++;
      clearTimeout(searching);
      editor.detach();
      dialogs.close();
      publishing.close();
      building.close();
      delivery.close();
      packages?.close();
      root.remove();
    },
  };
}
