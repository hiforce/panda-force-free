import type { Translate } from "../../../shared/i18n/messages.js";
import type { PluginPackage } from "../../../shared/plugins/contracts.js";
import type {
  TemplateDefinition,
  TemplateDraft,
  TemplateLibrarySnapshot,
  TemplateRelease,
  TemplateDraftPreview,
} from "../../../shared/plugins/library.js";
import { pluginApi, PluginApiError } from "../api.js";
import { packageReview } from "../views.js";
import { setMessageHtml, errorText } from "../../i18n.js";

import { templateLibraryApi as api } from "./api.js";
import { TemplateLibraryEditor } from "./editor.js";
import { templateDefinition } from "./defaults.js";
import { libraryFrame, libraryList, validationReport } from "./views.js";
import { createLibrarySamplePreview } from "./sample-preview.js";
import { readTemplateLibraryArchive } from "./import.js";

/** Server state and working form state have separate owners; list refresh never replaces a dirty editor. */
export function createTemplateLibrary(t: Translate, onClose: () => void, id = "templateLibraryDialog") {
  const dialog = document.createElement("dialog");
  dialog.id = id;
  dialog.className = "package-dialog template-library-dialog";
  document.body.append(dialog);
  const get = <T extends HTMLElement>(query: string) => dialog.querySelector<T>(query)!;
  let epoch = 0,
    busy = false,
    dirty = false,
    previous: Element | null = null,
    editor: TemplateLibraryEditor | null = null;
  let current: TemplateDraft | null = null,
    release: TemplateRelease | null = null,
    snapshot: TemplateLibrarySnapshot = { drafts: [], releases: [] };
  let preview: TemplateDraftPreview | null = null,
    discard: (() => void) | null = null;
  let selectedImport: { file: File; epoch: number } | null = null;
  const samplePreview = createLibrarySamplePreview(t, (result) => {
    preview = result;
    controls();
  });
  function controls() {
    const readonly = Boolean(release || (current?.publishedAt !== null && current));
    dialog.setAttribute("aria-busy", String(busy));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = button.dataset.libraryAction === "close" ? false : busy;
    for (const action of ["preview", "validate", "review", "baseline", "review-sample"]) {
      const button = get<HTMLButtonElement>(`[data-library-action="${action}"]`);
      if (button)
        button.disabled = busy || dirty || !current || readonly || (action === "review" && !current.validation?.passed);
    }
    const save = get<HTMLButtonElement>('[data-library-action="save"]');
    if (save) save.disabled = busy || readonly;
    const remove = get<HTMLButtonElement>('[data-library-action="delete"]');
    if (remove) remove.disabled = busy || !current;
    const fork = get<HTMLButtonElement>('[data-library-action="fork"]');
    if (fork) fork.disabled = busy || dirty || (!current && !release);
    editor?.controls(busy, readonly);
    const state = get("#librarySavedState");
    if (state) state.textContent = t(dirty ? "plugins.libraryUnsaved" : "plugins.librarySaved");
  }
  function notice(text: string, failed = false) {
    const node = get("#libraryNotice");
    if (node) {
      node.textContent = text;
      node.dataset.error = String(failed);
    }
  }
  function changed() {
    dirty = true;
    preview = null;
    samplePreview.clear();
    get("#libraryApproval")?.replaceChildren();
    controls();
  }
  function close(notify = true) {
    epoch++;
    samplePreview.clear();
    dialog.close();
    dialog.replaceChildren();
    editor = null;
    current = null;
    release = null;
    preview = null;
    discard = null;
    selectedImport = null;
    dirty = false;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    previous = null;
    if (notify) onClose();
  }
  function navigate(task: () => void) {
    if (!dirty) return task();
    discard = task;
    get("#libraryDiscard").hidden = false;
    get("#libraryDiscard").scrollIntoView({ block: "nearest" });
  }
  async function run(task: (generation: number) => Promise<void>) {
    if (busy || !dialog.open) return;
    busy = true;
    const generation = epoch;
    controls();
    notice(t("plugins.working"));
    try {
      await task(generation);
    } catch (error) {
      if (generation === epoch)
        notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        );
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
        importSelected();
      }
    }
  }
  function importSelected() {
    if (busy || !dialog.open || !selectedImport) return;
    const selected = selectedImport;
    selectedImport = null;
    if (selected.epoch !== epoch) return;
    navigate(
      () =>
        void run(async (generation) => {
          const definition = await readTemplateLibraryArchive(selected.file);
          if (generation !== epoch) return;
          const result = await api.save(definition, null);
          if (generation !== epoch) return;
          install(result.draft.definition, result.draft);
          await refresh(generation);
        }),
    );
  }
  function list() {
    setMessageHtml(get("#libraryList"), libraryList(t, snapshot, get<HTMLInputElement>("#librarySearch").value));
  }
  async function refresh(generation: number) {
    const next = await api.list();
    if (generation !== epoch) return;
    snapshot = next;
    list();
    notice("");
  }
  function install(
    definition: TemplateDefinition,
    draft: TemplateDraft | null = null,
    published: TemplateRelease | null = null,
  ) {
    samplePreview.clear();
    const selected = current?.id === draft?.id ? editor?.selectedFixture : undefined;
    current = draft;
    release = published;
    dirty = !draft && !published;
    preview = null;
    get("#libraryEditorEmpty").hidden = true;
    get("#libraryContent").hidden = false;
    get("#libraryApproval").replaceChildren();
    get("#libraryPreview").replaceChildren();
    get("#libraryDeleteConfirm").hidden = true;
    editor = new TemplateLibraryEditor(get("#libraryEditor"), t, changed, () => samplePreview.clear());
    editor.mount(definition, selected);
    setMessageHtml(get("#libraryReport"), validationReport(t, current, release));
    controls();
  }
  async function action(name: string, button: HTMLButtonElement, generation: number) {
    if (name === "refresh") return refresh(generation);
    if (name === "select") {
      const result = await api.detail(button.dataset.id!);
      if (generation === epoch) install(result.draft.definition, result.draft);
      return;
    }
    if (name === "release") {
      const result = await api.release(button.dataset.id!, button.dataset.version!);
      if (generation === epoch) install(result.release.definition, null, result.release);
      return;
    }
    if (name === "save") {
      const result = await api.save(await editor!.value(), current);
      if (generation !== epoch) return;
      install(result.draft.definition, result.draft);
      await refresh(generation);
      return;
    }
    if (name === "preview" && current) {
      await samplePreview.show(get("#libraryPreview"), current, editor!.selectedFixture);
      if (generation !== epoch) return;
      notice("");
      return;
    }
    if (name === "review-sample" && current) {
      const pinned = current,
        selected = editor!.selectedFixture,
        review = await pluginApi.review(pinned.definition.package);
      if (generation !== epoch) return;
      setMessageHtml(get("#libraryApproval"), packageReview(t, review, "librarySamplePackage"));
      get<HTMLFormElement>("#librarySamplePackageApproval").onsubmit = (event) => {
        event.preventDefault();
        if (!get<HTMLInputElement>("#librarySamplePackageAccept").checked) return;
        void run(async (generation) => {
          await pluginApi.install(pinned.definition.package, review);
          if (generation !== epoch) return;
          get("#libraryApproval").replaceChildren();
          await samplePreview.show(get("#libraryPreview"), pinned, selected);
          if (generation === epoch) notice(t("plugins.sampleThemeReviewed"));
        });
      };
      notice(t("plugins.readyForReview"));
      return;
    }
    if (name === "baseline" && current && preview) {
      if (preview.definitionDigest !== current.digest || preview.draftRevision !== current.revision)
        throw new PluginApiError(409, { messageId: "plugins.libraryConflict" });
      const result = await api.baseline(current, preview.fixtureId, preview.actualDigest!);
      if (generation !== epoch) return;
      install(result.draft.definition, result.draft);
      await refresh(generation);
      return;
    }
    if (name === "validate" && current) {
      const showingPreview = Boolean(preview);
      const result = await api.validate(current);
      if (generation !== epoch) return;
      current = result.draft;
      setMessageHtml(get("#libraryReport"), validationReport(t, current, null));
      if (showingPreview) await samplePreview.show(get("#libraryPreview"), current, editor!.selectedFixture);
      if (generation !== epoch) return;
      await refresh(generation);
      return;
    }
    if (name === "fork") {
      const version = get<HTMLInputElement>("#libraryNextVersion").value;
      const result = release
        ? await api.forkRelease(release.id, release.version, version)
        : await api.fork(current!, version);
      if (generation !== epoch) return;
      install(result.draft.definition, result.draft);
      await refresh(generation);
      return;
    }
    if (name === "review" && current) {
      const pinned = current,
        review = await pluginApi.review(current.definition.package);
      if (generation !== epoch) return;
      setMessageHtml(
        get("#libraryApproval"),
        packageReview(t, review, "libraryPackage", "plugins.libraryConfirmArchive"),
      );
      get<HTMLFormElement>("#libraryPackageApproval").onsubmit = (event) => {
        event.preventDefault();
        if (!get<HTMLInputElement>("#libraryPackageAccept").checked) return;
        void run(async (generation) => {
          const result = await api.publish(pinned, review);
          if (generation !== epoch) return;
          install(result.release.definition, null, result.release);
          await refresh(generation);
          notice(t("plugins.libraryPublishedState"));
        });
      };
      notice(t("plugins.readyForReview"));
      return;
    }
    if (name === "export") {
      const definition = release?.definition || (await editor!.value()),
        blob = new Blob(
          [
            JSON.stringify(
              {
                schema: 1,
                definition,
                ...(release
                  ? {
                      release: {
                        id: release.id,
                        version: release.version,
                        digest: release.digest,
                        publishedAt: release.publishedAt,
                      },
                      verification: release.validation,
                    }
                  : {}),
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        );
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `${definition.package.manifest.id}-${definition.package.manifest.version}.template.json`;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      notice("");
      return;
    }
    if (name === "confirm-delete" && current) {
      await api.remove(current);
      if (generation !== epoch) return;
      current = null;
      release = null;
      dirty = false;
      preview = null;
      editor = null;
      get("#libraryContent").hidden = true;
      get("#libraryEditorEmpty").hidden = false;
      get("#libraryEditor").replaceChildren();
      get("#libraryApproval").replaceChildren();
      get("#libraryPreview").replaceChildren();
      get("#libraryDeleteConfirm").hidden = true;
      await refresh(generation);
      return;
    }
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    navigate(() => close());
  });
  dialog.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-library-action]") : null;
    if (!button || button.disabled) return;
    const name = button.dataset.libraryAction!;
    if (name === "close") return navigate(() => close());
    if (name === "import") return get<HTMLInputElement>("#libraryImport").click();
    if (name === "keep") {
      discard = null;
      get("#libraryDiscard").hidden = true;
      return;
    }
    if (name === "discard") {
      const task = discard;
      discard = null;
      get("#libraryDiscard").hidden = true;
      dirty = false;
      task?.();
      return;
    }
    if (name === "delete" || name === "cancel-delete") {
      get("#libraryDeleteConfirm").hidden = name !== "delete";
      return;
    }
    if (name === "new") return navigate(() => install(templateDefinition()));
    const execute = () => void run((generation) => action(name, button, generation));
    if (["select", "release"].includes(name)) navigate(execute);
    else execute();
  });
  return {
    close,
    open(value?: PluginPackage) {
      close(false);
      previous = document.activeElement;
      busy = false;
      setMessageHtml(dialog, libraryFrame(t));
      if (window.matchMedia("(max-width:700px)").matches) get<HTMLDetailsElement>(".library-browser").open = false;
      dialog.showModal();
      get<HTMLInputElement>("#librarySearch").oninput = list;
      get<HTMLInputElement>("#libraryImport").onchange = () => {
        const input = get<HTMLInputElement>("#libraryImport"),
          file = input.files?.[0];
        if (!file) return;
        selectedImport = { file, epoch };
        input.value = "";
        importSelected();
      };
      void run(async (generation) => {
        await refresh(generation);
        if (value && generation === epoch) install(templateDefinition(value));
      });
    },
  };
}
