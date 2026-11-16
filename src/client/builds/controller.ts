import type { SiteThemeDescriptor } from "../../shared/presentation/themes.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentSpace } from "../../shared/documents/contracts.js";
import type { SiteBuild, SiteBuildRequest, BuildAvailability } from "../../shared/builds/jobs.js";
import { setMessageHtml, localizeText, errorText } from "../i18n.js";

import { siteBuildApi, SiteBuildApiError } from "./api.js";
import { createSitePreview } from "./preview.js";
import { buildFrame, buildHistory, buildDetail, activeBuild } from "./views.js";
import type { DocumentPublicationScope } from "../documents/publication/port.js";
import type { SiteSourceProfile } from "../../shared/sites/profile.js";
import { createBuildThemeSelection } from "./theme-selection.js";
import type { BuildEngine } from "../../shared/builds/engines.js";

/** This surface owns inspection and form state; job state remains server-owned across navigation. */
export function createSiteBuildWorkspace(
  t: Translate,
  delivery: { open(space: DocumentSpace, build: SiteBuild): void; close(): void },
) {
  const preview = createSitePreview(t);
  const themeSelection = createBuildThemeSelection(t);
  const dialog = document.createElement("dialog");
  dialog.id = "siteBuildDialog";
  dialog.className = "builds-dialog";
  document.body.append(dialog);
  let epoch = 0,
    metadataReads = 0,
    listReads = 0,
    selected = "",
    selection = 0,
    busy = false,
    signature = "",
    view = "logs";
  let projectId: string | undefined;
  let space: DocumentSpace | null = null,
    current: SiteBuild | null = null,
    jobs: SiteBuild[] = [];
  let themes: SiteThemeDescriptor[] = [],
    defaults: Record<string, string> = {};
  let sourceProfile: SiteSourceProfile | null = null;
  let availability: BuildAvailability = { state: "unconfigured", engines: {} },
    previous: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined,
    pending: SiteBuildRequest | null = null;
  const get = <T extends Element>(query: string) => dialog.querySelector<T>(query)!;
  function close() {
    delivery.close();
    themeSelection.close();
    preview.clear();
    epoch++;
    metadataReads++;
    listReads++;
    selection++;
    clearTimeout(timer);
    dialog.close();
    space = null;
    projectId = undefined;
    current = null;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  }
  function notice(value: string, error = false) {
    const target = get<HTMLElement>("#buildNotice");
    if (target) {
      target.textContent = value;
      target.dataset.error = String(error);
    }
  }
  function report(error: unknown) {
    notice(errorText(error instanceof SiteBuildApiError ? error.payload : null, t, "builds.unavailable"), true);
  }
  function controls() {
    const engine = get<HTMLSelectElement>("#build-engine")?.value;
    const reference = space?.theme === "default" ? defaults[engine] : space?.theme;
    const theme = themes.find((item) => `${item.id}@${item.version}` === reference);
    const chosen = themeSelection.current(engine, theme),
      compatible = chosen.compatible;
    const create = get<HTMLButtonElement>("#createSiteBuild");
    if (create) {
      create.disabled =
        busy ||
        !compatible ||
        (chosen.native
          ? !availability.nativeResources
          : !availability.themes || (theme?.kind === "installed" && !availability.trustedThemes)) ||
        (Boolean(sourceProfile) &&
          (!availability.siteProjects || !sourceProfile?.editions[get<HTMLInputElement>("#build-locale").value])) ||
        availability.state !== "ready" ||
        !availability.engines[engine as "hexo" | "docusaurus"];
      if (create.dataset.creating !== String(busy)) {
        create.dataset.creating = String(busy);
        localizeText(create, busy ? "builds.creating" : "builds.build", undefined, t);
      }
    }
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-build-action]")) {
      button.disabled = busy && !["close", "preview", "logs", "snapshot"].includes(button.dataset.buildAction!);
    }
    if (get("#buildPreset")) get<HTMLElement>("#buildPreset").textContent = chosen.label;
    if (get("#buildThemeHint"))
      get<HTMLElement>("#buildThemeHint").textContent =
        chosen.native && !availability.nativeResources && availability.state === "ready"
          ? t("builds.resourceBuildExecutorRequired")
          : !chosen.native && !availability.themes && availability.state === "ready"
            ? t("builds.themeExecutorRequired")
            : !chosen.native && theme?.kind === "installed" && !availability.trustedThemes
              ? t("builds.trustedThemeExecutorRequired")
              : sourceProfile && !availability.siteProjects
                ? t("builds.sourceProjectExecutorRequired")
                : sourceProfile && !sourceProfile.editions[get<HTMLInputElement>("#build-locale").value]
                  ? t("documents.sourceEditionMissing")
                  : !compatible
                    ? t("builds.incompatibleTheme")
                    : chosen.description;
  }
  function history() {
    const target = get<HTMLElement>("#buildHistory"),
      top = target.scrollTop;
    setMessageHtml(target, buildHistory(t, jobs, selected));
    target.scrollTop = top;
  }
  function tab(next: string) {
    view = next;
    for (const [key, id] of [
      ["preview", "Preview"],
      ["logs", "Log"],
      ["snapshot", "Snapshot"],
    ]) {
      const pane = get<HTMLElement>(`#build${id}Pane`);
      if (pane) pane.hidden = next !== key;
      const button = get<HTMLButtonElement>(`[data-build-action="${key}"]`);
      button?.setAttribute("aria-pressed", String(next === key));
    }
    if (next === "preview" && current?.artifactAvailable) {
      const mount = get<HTMLElement>("#buildPreviewMount");
      void preview.mount(mount, current.id);
    }
  }
  function detail(job: SiteBuild, logs: string) {
    current = job;
    const next = JSON.stringify({ ...job, updatedAt: 0 });
    if (next !== signature) {
      signature = next;
      setMessageHtml(get("#buildDetail"), buildDetail(t, job));
      const error = get<HTMLElement>("#buildError");
      if (job.error) error.textContent = errorText({ messageId: `builds.${job.error}` }, t, "builds.buildFailed");
      tab(view === "preview" && !job.artifactAvailable ? "logs" : view);
      controls();
    }
    const target = get<HTMLElement>("#buildLogPane");
    const following = target.scrollHeight - target.clientHeight - target.scrollTop < 24;
    const value = logs || t("builds.noLogs");
    if (target.textContent !== value) {
      target.textContent = value;
      if (following) target.scrollTop = target.scrollHeight;
    }
  }
  async function loadDetail() {
    const id = selected,
      generation = epoch,
      version = ++selection;
    if (!id) return;
    const result = await siteBuildApi.detail(id);
    if (generation !== epoch || version !== selection || selected !== id) return;
    detail(result.build, result.logs);
  }
  async function refresh(capabilities = false) {
    if (!space) return;
    const generation = epoch;
    if (capabilities) {
      const read = ++metadataReads;
      const [result, catalog, metadata, native] = await Promise.all([
        siteBuildApi.availability(),
        siteBuildApi.themes(),
        siteBuildApi.configuration(space.id, projectId),
        siteBuildApi.nativeThemes(),
      ]);
      if (generation !== epoch || read !== metadataReads) return;
      space = metadata.space;
      const firstLoad = !themes.length;
      availability = result;
      themes = catalog.themes;
      defaults = catalog.defaults;
      themeSelection.update(native.themes);
      sourceProfile = metadata.profile;
      if (firstLoad) applyEdition();
      if (firstLoad && space?.engine === "markdown" && space.theme !== "default") {
        const selectedTheme = themes.find((item) => `${item.id}@${item.version}` === space?.theme);
        if (selectedTheme) get<HTMLSelectElement>("#build-engine").value = selectedTheme.engine;
      }
      localizeText(
        get("#buildAvailability"),
        {
          ready: "builds.availabilityReady",
          unconfigured: "builds.availabilityUnconfigured",
          unavailable: "builds.availabilityUnavailable",
          incompatible: "builds.availabilityIncompatible",
        }[result.state] as "builds.availabilityReady",
        undefined,
        t,
      );
      controls();
    }
    const read = ++listReads;
    const result = await siteBuildApi.list(space.id, projectId);
    if (generation !== epoch || read !== listReads) return;
    jobs = result.builds;
    if (!selected && jobs.length) selected = jobs[0]!.id;
    history();
    await loadDetail();
  }
  function poll() {
    clearTimeout(timer);
    const generation = epoch;
    timer = setTimeout(async () => {
      if (generation !== epoch || !space) return;
      try {
        if (!document.hidden && jobs.some(activeBuild)) await refresh();
      } catch (error) {
        if (generation === epoch) report(error);
      } finally {
        if (generation === epoch) poll();
      }
    }, 2500);
  }
  async function action(name: string, button: HTMLButtonElement) {
    const generation = epoch;
    if (name === "theme" && space) {
      const engine = get<HTMLSelectElement>("#build-engine").value as BuildEngine,
        ref = space.theme === "default" ? defaults[engine] : space.theme,
        configured = themes.find((value) => value.id + "@" + value.version === ref && value.engine === engine);
      await themeSelection.choose(engine, configured);
      if (generation === epoch) controls();
      return;
    }
    if (name === "refresh") {
      await refresh(true);
      return;
    }
    if (name === "select") {
      selected = button.dataset.id!;
      signature = "";
      view = "logs";
      history();
      await loadDetail();
      return;
    }
    if (!current) return;
    if (name === "publish" && space) {
      delivery.open(space, current);
      return;
    }
    if (["preview", "logs", "snapshot"].includes(name)) {
      tab(name);
      return;
    }
    if (name === "delete" || name === "keep") {
      get<HTMLElement>("#buildDeleteConfirm").hidden = name === "keep";
      return;
    }
    if (name === "download") {
      await siteBuildApi.download(current.id);
      return;
    }
    if (name === "cancel") await siteBuildApi.cancel(current.id);
    if (name === "confirm-delete") {
      await siteBuildApi.remove(current.id);
      if (generation !== epoch) return;
      selected = "";
      current = null;
      signature = "";
    }
    if (generation !== epoch) return;
    await refresh();
    if (generation !== epoch) return;
    if (!current) localizeText(get("#buildDetail"), "builds.selectBuild", undefined, t);
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("change", (event) => {
    if ((event.target as Element)?.id === "build-engine") {
      themeSelection.engineChanged();
      controls();
    }
    if ((event.target as Element)?.id === "build-locale") {
      applyEdition();
      controls();
    }
  });
  function applyEdition() {
    const edition = sourceProfile?.editions[get<HTMLInputElement>("#build-locale").value];
    if (!edition) return;
    for (const [key, value] of Object.entries({ title: edition.title, url: edition.url, basePath: edition.basePath }))
      get<HTMLInputElement>("#build-" + key).value = value;
  }
  dialog.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-build-action]") : null;
    if (!button || button.disabled) return;
    if (button.dataset.buildAction === "close") {
      close();
      return;
    }
    const generation = epoch;
    button.disabled = true;
    void action(button.dataset.buildAction!, button)
      .catch((error) => {
        if (generation === epoch) report(error);
      })
      .finally(() => {
        if (generation === epoch) controls();
      });
  });
  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !space || get<HTMLButtonElement>("#createSiteBuild").disabled) return;
    const fields = Object.fromEntries(
      [...new FormData(get<HTMLFormElement>("#siteBuildForm"))].map(([key, value]) => [
        key.replace(/^site-/, ""),
        value,
      ]),
    );
    const request = {
      id: pending?.id || crypto.randomUUID(),
      spaceId: space.id,
      ...(projectId ? { projectId } : {}),
      spaceVersion: space.version,
      ...fields,
      ...(themeSelection.reference() ? { nativeTheme: themeSelection.reference()! } : {}),
    } as unknown as SiteBuildRequest;
    if (pending && JSON.stringify(pending) !== JSON.stringify(request)) request.id = crypto.randomUUID();
    pending = request;
    busy = true;
    controls();
    notice(t("builds.creating"));
    const generation = epoch;
    void siteBuildApi
      .create(request)
      .then(async ({ build }) => {
        if (generation !== epoch) return;
        pending = null;
        selected = build.id;
        signature = "";
        view = "logs";
        if (window.matchMedia("(max-width: 700px)").matches) get<HTMLDetailsElement>(".builds-settings").open = false;
        notice("");
        await refresh();
      })
      .catch((error) => {
        if (generation === epoch) report(error);
      })
      .finally(() => {
        if (generation === epoch) {
          busy = false;
          controls();
        }
      });
  });
  return {
    close,
    open(
      value: DocumentSpace,
      initialSelection?: { locale: string; returnFocus?: HTMLElement; scope?: DocumentPublicationScope },
    ) {
      close();
      previous = initialSelection?.returnFocus || document.activeElement;
      space = value;
      projectId = initialSelection?.scope?.storage === "files" ? initialSelection.scope.projectId : undefined;
      jobs = [];
      selected = "";
      signature = "";
      current = null;
      view = "logs";
      busy = false;
      pending = null;
      themes = [];
      defaults = {};
      themeSelection.reset();
      sourceProfile = null;
      availability = { state: "unconfigured", engines: {} };
      setMessageHtml(dialog, buildFrame(t, value));
      if (initialSelection) get<HTMLInputElement>("#build-locale").value = initialSelection.locale;
      dialog.showModal();
      controls();
      const generation = epoch;
      notice(t("builds.loading"));
      void refresh(true)
        .then(() => {
          if (generation === epoch) notice("");
        })
        .catch((error) => {
          if (generation === epoch) report(error);
        });
      poll();
    },
  };
}
