import type { Translate } from "../../../shared/i18n/messages.js";
import type { TemplateDraft, TemplateDraftPreview } from "../../../shared/plugins/library.js";
import { PluginApiError } from "../api.js";
import { templateLibraryApi as api } from "./api.js";
import { libraryPreview } from "./preview.js";
import { createSiteSampleMonitor } from "../../site-samples/controller.js";

/** Owns preview requests and a site monitor; the editor controller only receives a matching immutable result. */
export function createLibrarySamplePreview(t: Translate, changed: (result: TemplateDraftPreview | null) => void) {
  let epoch = 0,
    host: HTMLElement | null = null,
    summary: HTMLElement | null = null;
  let draft: TemplateDraft | null = null,
    fixtureId = "";
  const monitor = createSiteSampleMonitor(t, { completed: () => refresh() });
  function clear() {
    epoch++;
    monitor.clear();
    host?.replaceChildren();
    host = null;
    summary = null;
    draft = null;
    fixtureId = "";
    changed(null);
  }
  async function refresh() {
    if (!draft || !summary) return;
    const generation = epoch,
      pinned = draft,
      result = await api.preview(pinned.id, fixtureId);
    if (generation !== epoch) return;
    if (result.definitionDigest !== pinned.digest || result.draftRevision !== pinned.revision)
      throw new PluginApiError(409, { messageId: "plugins.libraryConflict" });
    libraryPreview(summary, result, t);
    changed(result);
  }
  async function show(target: HTMLElement, value: TemplateDraft, selected: string) {
    clear();
    host = target;
    draft = value;
    fixtureId = selected;
    const generation = epoch;
    summary = document.createElement("div");
    target.append(summary);
    await refresh();
    if (generation !== epoch || value.definition.fixtures.find((item) => item.id === selected)?.kind !== "site") return;
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "wb-button";
    approve.dataset.libraryAction = "review-sample";
    approve.textContent = t("plugins.sampleReviewTheme");
    const hint = document.createElement("p");
    hint.textContent = t("plugins.sampleReviewHint");
    const progress = document.createElement("div");
    target.append(hint, approve, progress);
    await monitor.mount(progress, { kind: "draft", id: value.id, revision: value.revision, fixtureId: selected });
  }
  return { show, clear };
}
