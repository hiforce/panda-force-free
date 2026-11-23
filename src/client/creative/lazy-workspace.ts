import type { Translate } from "../../shared/i18n/messages.js";
import type { ContentProject } from "./workspace.js";
import type { createLazyTemplateManager } from "../templates/lazy-settings.js";
import { DocumentRuntimeLoader, RuntimeLoadError } from "../documents/runtime-loader.js";
import { isModuleNetworkError } from "../documents/module-network-error.js";
import { prepareDocumentModule } from "../documents/module-transfer.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import { busyStatus } from "../busy-indicator.js";
import { ProjectReadAhead } from "./read-ahead.js";
import { projectLoadingView } from "./project-view.js";
import type { ComposerMount } from "../../gadget/system/composer/host.js";

const runtime = new DocumentRuntimeLoader({
  prime: (entry) =>
    prepareDocumentModule(entry ? "/content-workspace.bundle.js?retry=1" : "/content-workspace.bundle.js"),
  isTransferFailure: isModuleNetworkError,
  evaluate: (entry) =>
    entry ? import("/content-workspace.bundle.js?retry=1") : import("/content-workspace.bundle.js"),
});

/** A late optional module cannot replace a different route or revive a workspace after leaving it. */
export function createLazyContentWorkspace(
  kind: "create" | "project" | "directory" | "skills" | "publish",
  t: Translate,
  identity: string,
  projects: () => ContentProject[],
  navigate: (path: string) => void,
  manager?: ReturnType<typeof createLazyTemplateManager>,
  composer?: ComposerMount,
) {
  const readAhead = kind === "project" ? new ProjectReadAhead() : undefined;
  let epoch = 0,
    fatal = false,
    view: { show(host: HTMLElement, first?: string, second?: string): void; hide(): void } | null = null;
  function hide() {
    epoch++;
    readAhead?.cancel();
    view?.hide();
  }
  function skillShell(body: string, category?: string) {
    const title = !category || category === "all" ? "skillWorkspace.all" : "creative.skills";
    return `<section class="skills-workspace"><div class="skills-navigation" aria-hidden="true"></div><div class="skills-main"><header class="resource-heading skills-catalog-heading"><h1>${messageHtml(title, undefined, t)}</h1></header>${body}</div></section>`;
  }
  function failure(host: HTMLElement, retryable: boolean, first?: string, second?: string) {
    readAhead?.cancel();
    const pane = `<div class="content-workspace-recovery"><p role="status" data-content-workspace-status>${messageHtml(retryable ? "common.pageLoadFailed" : "common.pageReloadRequired", undefined, t)}</p><button type="button" class="wb-button" data-content-workspace-retry>${messageHtml(retryable ? "common.retry" : "common.reloadWorkspace", undefined, t)}</button></div>`;
    setMessageHtml(host, kind === "skills" ? skillShell(pane, first) : pane);
    host.querySelector<HTMLButtonElement>("[data-content-workspace-retry]")!.onclick = () =>
      retryable ? show(host, first, second) : location.reload();
  }
  function show(host: HTMLElement, first?: string, second?: string) {
    const current = ++epoch;
    if (fatal) return failure(host, false, first, second);
    if (view) return view.show(host, first, second);
    if (first) readAhead?.prepare(first);
    const pending = `<p class="busy-status busy-status-panel" role="status" data-content-workspace-status>${busyStatus(t, kind === "skills" ? "creation.loadingSkill" : "common.pageLoading")}</p>`;
    setMessageHtml(
      host,
      ["project", "directory"].includes(kind) && first
        ? projectLoadingView(
            t,
            first,
            projects().find((project) => project.id === first),
            kind === "directory" ? "documents" : "content",
          )
        : kind === "skills"
          ? skillShell(pending, first)
          : pending,
    );
    void runtime.load().then(
      (loaded) => {
        if (current !== epoch) return;
        try {
          view ??= loaded.createContentWorkspace(kind, t, identity, projects, navigate, manager, readAhead, composer);
          view.show(host, first, second);
        } catch {
          fatal = true;
          failure(host, false, first, second);
        }
      },
      (error) => {
        if (current !== epoch) return;
        const retryable = error instanceof RuntimeLoadError && error.retryable;
        fatal = !retryable;
        failure(host, retryable, first, second);
      },
    );
  }
  return { show, hide };
}
