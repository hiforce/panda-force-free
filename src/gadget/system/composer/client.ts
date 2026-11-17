import manifest from "./manifest.json";
import { composerFrame } from "./view.js";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import type { ComposerCapability } from "../bindings.js";
import type { ClientGadgetRegistry, GadgetContext } from "../../../client/gadget/contracts.js";
import { setMessageHtml } from "../../../client/i18n.js";
import { gt } from "../../../client/gadget/messages.js";
import { CreationDrafts, type CreationDraft } from "../../../client/creation/drafts.js";
import { DocumentRuntimeLoader, RuntimeLoadError } from "../../../client/documents/runtime-loader.js";
import { isModuleNetworkError } from "../../../client/documents/module-network-error.js";
import { prepareDocumentModule } from "../../../client/documents/module-transfer.js";
import { staticAssetUrl } from "../../../client/static-assets.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { createComposerDisclosure } from "../../../client/message-composer-disclosure.js";
const entries = [
  "/gadget-document.bundle.js",
  "/gadget-document.bundle.js?retry=1",
  "/gadget-document.bundle.js?retry=2",
  "/gadget-document.bundle.js?retry=3",
];
const runtime = new DocumentRuntimeLoader<typeof import("./document.js")>({
  prime: (entry) => prepareDocumentModule(staticAssetUrl(entries[entry]!)),
  isTransferFailure: isModuleNetworkError,
  maxTransferRetries: 3,
  evaluate: (entry) =>
    entry === 0
      ? import("/gadget-document.bundle.js")
      : entry === 1
        ? import("/gadget-document.bundle.js?retry=1")
        : entry === 2
          ? import("/gadget-document.bundle.js?retry=2")
          : import("/gadget-document.bundle.js?retry=3"),
});
export function register(registry: ClientGadgetRegistry) {
  registry.register(manifest as GadgetManifest, {
    mount(root, initial) {
      let context = initial,
        live = true,
        generation = 0,
        loading = false,
        unavailable = false,
        reload = false,
        automaticRetries = 0,
        composing = false,
        deferred: typeof import("./document.js") | null = null,
        retryTimer: ReturnType<typeof setTimeout> | undefined,
        composer: ReturnType<typeof import("./document.js").createDocumentComposer> | null = null;
      let disclosure: ReturnType<typeof createComposerDisclosure> | null = null;
      const access = context.capability<ComposerCapability>("panda.composer"),
        project = access.creationProject() || "personal",
        store = new CreationDrafts(access.identity, project),
        pendingSkills: unknown[] = [];
      const draft = (): CreationDraft =>
        store.load() ?? {
          prompt: access.taskDraft(project),
          profileId: "",
          parentId: null,
          selections: [],
          pending: null,
          skillsVersion: 2,
        };
      let flushing = false;
      function status() {
        if (composer || !live) return;
        const saved = draft(),
          textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
        textarea.placeholder = gt(context.t, "briefPlaceholder");
        textarea.setAttribute("aria-label", context.t("creation.prompt"));
        textarea.disabled = !!saved.pending;
        root.querySelector<HTMLButtonElement>("[data-gd-skills]")!.disabled = true;
        root.querySelector("[data-gd-skill-label]")!.textContent = context.t("creation.addSkill");
        root.querySelector<HTMLButtonElement>("[data-gd-project]")!.disabled = true;
        root.querySelector("[data-gd-project-title]")!.textContent =
          project === "personal"
            ? context.t("creative.personal")
            : access.projects().find((p) => p.id === project)?.title || project;
        const send = root.querySelector<HTMLButtonElement>("[data-gd-start]")!;
        send.disabled = !!saved.pending || saved.selections.length > 0 || pendingSkills.length > 0;
        send.setAttribute("aria-label", context.t("common.sendMessage"));
        root.querySelector<HTMLElement>("[data-gd-status]")!.hidden = false;
        root.querySelector("[data-gd-notice]")!.textContent = gt(
          context.t,
          unavailable ? "toolsUnavailable" : "toolsLoading",
        );
        const retry = root.querySelector<HTMLButtonElement>("[data-gd-retry]")!;
        retry.hidden = !unavailable;
        retry.disabled = loading;
        retry.textContent = context.t(reload ? "common.reloadWorkspace" : "common.retry");
      }
      function shell() {
        disclosure?.dispose();
        setMessageHtml(root, composerFrame(context, draft().prompt));
        disclosure = createComposerDisclosure(
          root.querySelector<HTMLFormElement>("form")!,
          context.t,
          access.identity,
          "entry:" + project,
        );
        const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
        textarea.oninput = () => {
          const value = draft();
          if (!value.pending) store.save({ ...value, prompt: textarea.value });
        };
        textarea.addEventListener("compositionstart", () => {
          composing = true;
        });
        textarea.addEventListener("compositionend", () => {
          composing = false;
          const value = draft();
          if (!value.pending) store.save({ ...value, prompt: textarea.value });
          if (deferred) attach(deferred);
        });
        textarea.onkeydown = (event) => {
          if (!event.isComposing && !composing && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            root.querySelector("form")!.requestSubmit();
          }
        };
        root.querySelector<HTMLButtonElement>("[data-gd-retry]")!.onclick = () =>
          reload ? location.reload() : void load();
        root.querySelector("form")!.onsubmit = (event) => {
          event.preventDefault();
          const value = draft();
          if (!live || composer || value.pending || value.selections.length || pendingSkills.length) return;
          if (!value.prompt.trim()) {
            textarea.focus();
            return;
          }
          access.startTask(value.prompt, project);
          store.save({ ...value, prompt: "" });
          if (live) textarea.value = "";
        };
        status();
      }
      async function flush() {
        if (flushing || !composer) return;
        flushing = true;
        try {
          while (pendingSkills.length && live) await composer.select(pendingSkills.shift());
        } finally {
          flushing = false;
        }
      }
      function attach(loaded: typeof import("./document.js")) {
        if (!live || composer) return;
        if (composing) {
          deferred = loaded;
          return;
        }
        deferred = null;
        const input = root.querySelector<HTMLTextAreaElement>("textarea")!,
          focused = document.activeElement === input,
          start = input.selectionStart,
          end = input.selectionEnd;
        disclosure?.dispose();
        disclosure = null;
        composer = loaded.createDocumentComposer(root, context);
        if (focused) {
          const next = root.querySelector<HTMLTextAreaElement>("textarea")!;
          next.focus({ preventScroll: true });
          next.setSelectionRange(start, end);
        }
        void flush();
      }
      async function load() {
        if (loading || !live || composer) return;
        const ticket = ++generation;
        loading = true;
        unavailable = false;
        status();
        clearTimeout(retryTimer);
        try {
          const loaded = await runtime.load();
          if (!live || ticket !== generation) return;
          attach(loaded);
        } catch (error) {
          if (!live || ticket !== generation) return;
          reportDiagnostic("composer-tools", error);
          unavailable = true;
          reload = !(error instanceof RuntimeLoadError && error.retryable);
          if (!reload && automaticRetries++ < 1) retryTimer = setTimeout(() => void load(), 500);
        } finally {
          loading = false;
          status();
        }
      }
      context.events.subscribe("creation.skill-selected", (value) => {
        if (pendingSkills.length < 64) pendingSkills.push(value);
        if (composer) void flush();
        else {
          status();
          void load();
        }
      });
      shell();
      void load();
      return {
        update(next: GadgetContext) {
          context = next;
          disclosure?.refresh();
          if (composer) composer.update(next);
          else status();
        },
        dispose() {
          disclosure?.dispose();
          live = false;
          generation++;
          clearTimeout(retryTimer);
          composer?.dispose();
        },
      };
    },
  });
}
