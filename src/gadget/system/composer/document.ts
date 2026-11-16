import type { ComposerCapability } from "../bindings.js";
import type { GadgetContext } from "../../../client/gadget/contracts.js";
import { CreationSkills } from "../../../client/creation/skills.js";
import { CreationDrafts, selectCreationSkill, type CreationDraft } from "../../../client/creation/drafts.js";
import { LazyDocumentCreationPanel } from "../../../client/creation/lazy-panel.js";
import { documentTreeApi } from "../../../client/documents/authoring/tree-api.js";
import { DocumentApiError } from "../../../client/documents/api.js";
import { creativeAssetsApi } from "../../../client/creative/assets-api.js";
import { DOCUMENT_CREATION_CAPABILITIES } from "../../../shared/creation/contracts.js";
import type { ManagedTemplate } from "../../../shared/templates/catalog.js";
import { isRecord } from "../../../shared/records.js";
import { errorText, setMessageHtml } from "../../../client/i18n.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { createAnchoredMenu } from "../../../client/anchored-menu.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { codexIcon } from "../../../client/codex-icons.js";
import { gt } from "../../../client/gadget/messages.js";
/** One input dispatches plain tasks to the native transaction and selected skills to the document adapter. */
export function createDocumentComposer(root: HTMLElement, initial: GadgetContext) {
  let context = initial,
    scope = initial.capability<ComposerCapability>("panda.composer").creationProject() || "personal",
    store = new CreationDrafts(initial.capability<ComposerCapability>("panda.composer").identity, scope),
    skills: CreationSkills | null = null,
    live = true,
    epoch = 0,
    busy = false,
    treeVersion = 0;
  const request = new AbortController(),
    destinationMenu = createAnchoredMenu();
  let failure: unknown = null;
  let destinationList: HTMLElement;
  const panel = new LazyDocumentCreationPanel(
    initial.t,
    initial.capability<ComposerCapability>("panda.composer").identity,
  );
  if (!store.load()) {
    const prompt = initial.capability<ComposerCapability>("panda.composer").taskDraft(scope);
    if (prompt) store.save({ prompt, profileId: "", parentId: null, selections: [], pending: null, skillsVersion: 2 });
  }
  const draft = (): CreationDraft =>
    store.load() ?? { prompt: "", profileId: "", parentId: null, selections: [], pending: null, skillsVersion: 2 };
  const notice = (message: string, retry = false) => {
    root.querySelector<HTMLElement>("[data-gd-notice]")!.textContent = message;
    root.querySelector<HTMLElement>("[data-gd-status]")!.hidden = !message;
    root.querySelector<HTMLElement>("[data-gd-retry]")!.hidden = !retry;
  };
  function showFailure(error: unknown) {
    failure = error;
    reportDiagnostic("gadget-document-submit", error);
    notice(
      error instanceof DocumentApiError
        ? error.status === 401
          ? context.t("common.applicationSessionExpired")
          : error.status === 404
            ? gt(context.t, "destinationUnavailable")
            : errorText(error.payload, context.t, "documents.unavailable")
        : context.t("documents.unavailable"),
      !(error instanceof DocumentApiError && [401, 403, 404].includes(error.status)),
    );
  }
  const open = async (id: string) =>
    context
      .capability<ComposerCapability>("panda.composer")
      .navigate("/documents?" + new URLSearchParams({ project: scope, document: id }));
  function updateControls() {
    const value = draft();
    root.querySelector<HTMLButtonElement>("[data-gd-start]")!.disabled = busy;
    root.querySelector<HTMLButtonElement>("[data-gd-start]")!.setAttribute("aria-busy", String(busy));
    root.querySelector<HTMLButtonElement>("[data-gd-skills]")!.disabled = !!value.pending || busy;
    root.querySelector<HTMLTextAreaElement>("textarea")!.disabled = !!value.pending || busy;
    root.querySelector<HTMLButtonElement>("[data-gd-project]")!.disabled = !!value.pending || busy;
    root.querySelector<HTMLButtonElement>("[data-gd-retry]")!.disabled = busy;
    skills?.setLocked(!!value.pending || busy);
    const suggestions = root.querySelector<HTMLElement>("[data-gd-suggestions]");
    if (suggestions) {
      suggestions.hidden = scope === "personal" || !!value.prompt.trim() || !!value.pending;
      for (const button of suggestions.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
    }
  }
  function chooseSkills() {
    if (!skills) {
      const target = root.querySelector<HTMLElement>("[data-gd-selected]")!;
      skills = new CreationSkills(
        target,
        context.t,
        draft().selections,
        DOCUMENT_CREATION_CAPABILITIES,
        () => {
          const value = draft();
          if (!value.pending) {
            value.selections = skills!.read();
            store.save(value);
          }
        },
        () => notice(context.t("creation.skillLoadFailed")),
        "composer",
      );
    }
    updateControls();
    return skills;
  }
  function updateDestination() {
    const projects = context.capability<ComposerCapability>("panda.composer").projects();
    const title =
      scope === "personal"
        ? context.t("creative.personal")
        : projects.find((p) => p.id === scope)?.title || gt(context.t, "destinationMissing");
    const trigger = root.querySelector<HTMLButtonElement>("[data-gd-project]")!;
    trigger.querySelector("[data-gd-project-title]")!.textContent = title;
    trigger.title = gt(context.t, "saveTo") + ": " + title;
    trigger.setAttribute("aria-label", trigger.title);
  }
  function chooseDestination() {
    if (
      window.matchMedia("(pointer: coarse), (max-width: 767px)").matches &&
      document.activeElement instanceof HTMLElement
    )
      document.activeElement.blur();
    const trigger = root.querySelector<HTMLButtonElement>("[data-gd-project]")!;
    const menu = destinationList;
    if (trigger.getAttribute("aria-expanded") === "true") {
      destinationMenu.close(true);
      return;
    }
    const projects = [
      { id: "personal", title: context.t("creative.personal"), description: "" },
      ...context.capability<ComposerCapability>("panda.composer").projects(),
    ];
    setMessageHtml(
      menu,
      `<p>${e(gt(context.t, "saveTo"))}</p>${projects.map((p) => `<button type="button" data-gd-destination="${e(p.id)}" aria-current="${p.id === scope}">${codexIcon("folderOpen")}<span><strong>${e(p.title)}</strong>${p.description ? `<small>${e(p.description)}</small>` : ""}</span>${p.id === scope ? codexIcon("check") : ""}</button>`).join("")}`,
    );
    menu.onclick = (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-gd-destination]") : null;
      if (!button || busy || draft().pending) return;
      destinationMenu.close();
      if (button.dataset.gdDestination !== scope) {
        const previous = draft();
        scope = button.dataset.gdDestination!;
        epoch++;
        store = new CreationDrafts(context.capability<ComposerCapability>("panda.composer").identity, scope);
        if (!store.load()) store.save(previous);
        failure = null;
        render();
      }
      root.querySelector<HTMLButtonElement>("[data-gd-project]")!.focus();
    };
    destinationMenu.toggle(trigger, menu);
  }
  function render() {
    destinationMenu.close();
    skills?.close();
    skills = null;
    const saved = draft();
    setMessageHtml(
      root,
      `<form class="gadget-document-form"><div data-gd-selected class="creative-selected-skills"></div><textarea id="gadgetDocumentPrompt" aria-label="${e(context.t("creation.prompt"))}" placeholder="${e(gt(context.t, "briefPlaceholder"))}" rows="5">${e(saved.prompt)}</textarea><div class="gadget-document-suggestions" data-gd-suggestions hidden>${(["article", "plan", "notes"] as const).map((key) => `<button type="button" data-gd-suggestion="${key}">${e(context.t(`projects.idea${key === "article" ? "Article" : key === "plan" ? "Plan" : "Notes"}`))}${codexIcon("arrowUpRight")}</button>`).join("")}</div><footer><button type="button" class="gadget-document-skill" data-gd-skills>${codexIcon("plus")}<span data-gd-skill-label>${e(context.t("creation.addSkill"))}</span></button><button type="button" class="gadget-document-destination" data-gd-project aria-haspopup="menu" aria-expanded="false">${codexIcon("folderOpen")}<span data-gd-project-title></span>${codexIcon("chevronDown")}</button><div data-gd-project-menu class="gadget-document-destinations" hidden></div><button type="submit" class="gadget-document-send" data-gd-start aria-label="${e(context.t("common.sendMessage"))}">${codexIcon("arrowUp")}</button></footer><div class="gadget-document-status" data-gd-status hidden><p data-gd-notice role="status"></p><button type="button" data-gd-retry hidden>${e(gt(context.t, "retry"))}</button></div></form>`,
    );
    destinationList = root.querySelector<HTMLElement>("[data-gd-project-menu]")!;
    const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.oninput = () => {
      const value = draft();
      if (!value.pending) {
        value.prompt = textarea.value;
        store.save(value);
        updateControls();
      }
    };
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-gd-suggestion]"))
      button.onclick = () => {
        const key = button.dataset.gdSuggestion;
        if (!textarea.value.trim() && !busy && !draft().pending) {
          textarea.value = context.t(
            key === "article"
              ? "projects.promptArticle"
              : key === "plan"
                ? "projects.promptPlan"
                : "projects.promptNotes",
          );
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
        textarea.focus();
      };
    root.querySelector<HTMLButtonElement>("[data-gd-skills]")!.onclick = (event) =>
      chooseSkills().browse(event.currentTarget as HTMLElement);
    root.querySelector<HTMLButtonElement>("[data-gd-project]")!.onclick = chooseDestination;
    root.querySelector<HTMLButtonElement>("[data-gd-retry]")!.onclick = () => {
      if (!busy) void start();
    };
    root.querySelector("form")!.onsubmit = (event) => {
      event.preventDefault();
      if (!live || busy) return;
      void start();
    };
    textarea.onkeydown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        root.querySelector("form")!.requestSubmit();
      }
    };
    if (saved.selections.length) chooseSkills();
    updateDestination();
    updateControls();
  }
  async function start() {
    busy = true;
    updateControls();
    const value = draft();
    if (!value.prompt.trim() && !value.pending) {
      busy = false;
      updateControls();
      root.querySelector("textarea")!.focus();
      return;
    }
    const project = scope,
      ticket = epoch;
    failure = null;
    try {
      if (!value.pending && !value.selections.length) {
        context.capability<ComposerCapability>("panda.composer").startTask(value.prompt, project);
        // The native transaction now owns acknowledgement, retries and its persisted draft.
        store.save({ ...value, prompt: "" });
        return;
      }
      notice(context.t("creation.creating"));
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
      const [tree, capability] = await Promise.all([
        documentTreeApi.read(project, signal),
        creativeAssetsApi.capabilities(project, signal),
      ]);
      if (!live || project !== scope || ticket !== epoch) return;
      if (!capability.contribute || capability.originals === false) {
        showFailure(new DocumentApiError(403, { messageId: "gadget.destinationForbidden" }));
        return;
      }
      treeVersion = tree.version;
      await panel.open({
        projectId: project,
        treeVersion: () => treeVersion,
        locations: [
          {
            id: null,
            label:
              project === "personal"
                ? context.t("creative.personal")
                : context
                    .capability<ComposerCapability>("panda.composer")
                    .projects()
                    .find((p) => p.id === project)?.title || project,
          },
        ],
        parentId: null,
        prompt: value.prompt,
        submitOnOpen: true,
        open,
        manual: async () => {
          const latest = await documentTreeApi.read(project);
          const result = await documentTreeApi.commit({
            id: crypto.randomUUID(),
            projectId: project,
            treeVersion: latest.version,
            intent: { kind: "create", title: context.t("documents.untitled"), locale: context.locale, parentId: null },
          });
          await open(result.operation.documentId);
        },
        closed: () => {
          if (!live || project !== scope) return;
          root.querySelector<HTMLTextAreaElement>("textarea")!.value = draft().prompt;
          skills?.setSelected(draft().selections);
          notice("");
          updateControls();
          context.capability<ComposerCapability>("panda.composer").creationClosed?.();
        },
      });
      notice("");
    } catch (error) {
      if (live && project === scope && ticket === epoch) showFailure(error);
    } finally {
      busy = false;
      if (live) updateControls();
    }
  }
  render();
  return {
    update(next: GadgetContext) {
      const changed = context.locale !== next.locale;
      context = next;
      const prompt = root.querySelector<HTMLTextAreaElement>("textarea")!;
      prompt.placeholder = gt(context.t, "briefPlaceholder");
      prompt.setAttribute("aria-label", context.t("creation.prompt"));
      root.querySelector("[data-gd-skill-label]")!.textContent = context.t("creation.addSkill");
      root.querySelector("[data-gd-start]")!.setAttribute("aria-label", context.t("common.sendMessage"));
      for (const button of root.querySelectorAll<HTMLButtonElement>("[data-gd-suggestion]")) {
        const kind = button.dataset.gdSuggestion;
        setMessageHtml(
          button,
          `${e(context.t(kind === "article" ? "projects.ideaArticle" : kind === "plan" ? "projects.ideaPlan" : "projects.ideaNotes"))}${codexIcon("arrowUpRight")}`,
        );
      }
      updateDestination();
      root.querySelector("[data-gd-retry]")!.textContent = gt(context.t, "retry");
      if (changed) skills?.setSelected(draft().selections);
      if (changed) destinationMenu.close();
      if (changed && failure) showFailure(failure);
    },
    async select(value: unknown) {
      if (
        !isRecord(value) ||
        !isRecord(value.reference) ||
        value.reference.registry !== "skills" ||
        !("packageId" in value.reference) ||
        draft().pending
      )
        return;
      const template = value as unknown as ManagedTemplate,
        ref = template.reference;
      if (ref.registry !== "skills") return;
      const next = draft();
      next.selections = selectCreationSkill(next.selections, {
        packageId: ref.packageId,
        id: ref.exportId,
        version: ref.version,
        digest: ref.digest,
        parameters: {},
      });
      store.save(next);
      chooseSkills().setSelected(next.selections);
    },
    dispose() {
      live = false;
      epoch++;
      request.abort();
      destinationMenu.dispose();
      skills?.close();
      panel.close();
    },
  };
}
