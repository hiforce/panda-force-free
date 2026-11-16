import type { Translate } from "../../shared/i18n/messages.js";
import type { SiteThemeDescriptor } from "../../shared/presentation/themes.js";
import type { NativeThemeSummary } from "../../shared/templates/native/contracts.js";
import type { NativeBuildThemeRef } from "../../shared/builds/native-reference.js";
import type { BuildEngine } from "../../shared/builds/engines.js";
import { DocumentModal } from "../documents/modal.js";
import { createBuildSampleMonitor } from "../site-samples/monitor.js";
import { createSiteSampleMonitor } from "../site-samples/controller.js";
import { nativeSampleApi } from "../templates/native-sample-api.js";
import { presentationLabel } from "../presentation-labels.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";

/** The picker owns selection and preview lifetime, while the build form owns execution settings and intent. */
export function createBuildThemeSelection(t: Translate) {
  const modal = new DocumentModal(t, "buildThemePicker"),
    nativePreview = createBuildSampleMonitor(t, nativeSampleApi),
    configuredPreview = createSiteSampleMonitor(t);
  let templates: NativeThemeSummary[] = [],
    selected: NativeBuildThemeRef | null = null;
  const name = (theme: NativeThemeSummary, field: "name" | "description" = "name") =>
    theme.settings[field][document.documentElement.lang] ||
    theme.settings[field].en ||
    Object.values(theme.settings[field])[0] ||
    theme.id;
  const reference = (theme: NativeThemeSummary): NativeBuildThemeRef => ({
    id: theme.id,
    version: theme.version,
    digest: theme.digest,
  });
  function close() {
    nativePreview.clear();
    configuredPreview.clear();
    modal.close();
  }
  function current(engine: string, configured: SiteThemeDescriptor | undefined) {
    if (selected) {
      const native = templates.find(
        (theme) =>
          theme.id === selected!.id && theme.version === selected!.version && theme.digest === selected!.digest,
      );
      return {
        native: true,
        compatible: !!native?.enabled && native.settings.engine === engine,
        label: native ? name(native) + " · " + native.version : selected.id + " · " + selected.version,
        description: native ? name(native, "description") : t("builds.incompatibleTheme"),
      };
    }
    return {
      native: false,
      compatible: configured?.engine === engine,
      label: configured ? presentationLabel(t, configured) + " · " + configured.version : t("documents.themeDefault"),
      description: configured ? presentationLabel(t, configured, "description") : t("builds.incompatibleTheme"),
    };
  }
  async function choose(engine: BuildEngine, configured: SiteThemeDescriptor | undefined) {
    close();
    let choice: NativeThemeSummary | "configured" | null = selected
      ? (templates.find(
          (theme) =>
            theme.id === selected!.id &&
            theme.version === selected!.version &&
            theme.digest === selected!.digest &&
            theme.enabled &&
            theme.settings.engine === engine,
        ) ?? null)
      : configured
        ? "configured"
        : null;
    const pending = modal.form(
      t("builds.chooseTheme"),
      `<p>${e(t("builds.themeChoiceHint"))}</p><div class="build-theme-layout"><section><label for="buildThemeSearch">${e(t("templates.search"))}</label><input id="buildThemeSearch" type="search" autocomplete="off" maxlength="200"><div data-build-theme-choices></div><button type="button" class="wb-button" data-build-theme-more hidden>${e(t("templates.loadMore"))}</button></section><section><div data-build-theme-preview></div></section></div>`,
      t("builds.useTheme"),
      async () => (choice === "configured" ? { native: null } : { native: choice ? reference(choice) : null }),
      { canSubmit: () => choice !== null },
    );
    modal.element.classList.add("build-theme-picker");
    const generation = modal.generation,
      host = modal.element.querySelector<HTMLElement>("[data-build-theme-preview]")!,
      search = modal.element.querySelector<HTMLInputElement>("#buildThemeSearch")!,
      more = modal.element.querySelector<HTMLButtonElement>("[data-build-theme-more]")!;
    let limit = 30;
    function preview() {
      nativePreview.clear();
      configuredPreview.clear();
      if (choice === "configured") {
        if (configured)
          void configuredPreview.mount(host, {
            kind: "catalog",
            engine,
            reference: configured.id + "@" + configured.version,
          });
        else host.replaceChildren();
      } else if (choice) void nativePreview.mount(host, reference(choice));
      else host.replaceChildren();
    }
    function render() {
      const cards = modal.element.querySelector<HTMLElement>("[data-build-theme-choices]")!,
        term = search.value.toLowerCase().trim(),
        matches = templates.filter(
          (theme) =>
            theme.enabled &&
            theme.settings.engine === engine &&
            [theme.id, theme.version, name(theme), name(theme, "description"), theme.settings.publisher].some((value) =>
              value.toLowerCase().includes(term),
            ),
        ),
        rows = matches.slice(0, limit);
      cards.replaceChildren();
      const add = (
        key: string,
        title: string,
        description: string,
        meta: string,
        active: boolean,
        select: () => void,
      ) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "build-theme-card";
        button.dataset.buildTheme = key;
        button.setAttribute("aria-pressed", String(active));
        setMessageHtml(button, `<strong>${e(title)}</strong><span>${e(description)}</span><small>${e(meta)}</small>`);
        button.onclick = () => {
          select();
          render();
          preview();
        };
        cards.append(button);
      };
      if (configured)
        add(
          "configured",
          presentationLabel(t, configured),
          t("builds.configuredTheme"),
          engine + " · " + configured.version,
          choice === "configured",
          () => {
            choice = "configured";
          },
        );
      for (const theme of rows)
        add(
          theme.id + "@" + theme.version,
          name(theme),
          name(theme, "description"),
          theme.version + " · " + theme.settings.license.expression,
          choice !== null && choice !== "configured" && choice.digest === theme.digest,
          () => {
            choice = theme;
          },
        );
      if (!matches.length && !configured) {
        const empty = document.createElement("p");
        empty.textContent = t("templates.empty");
        cards.append(empty);
      }
      more.hidden = matches.length <= limit;
      modal.element.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = !choice;
    }
    search.oninput = () => {
      limit = 30;
      render();
    };
    more.onclick = () => {
      limit += 30;
      render();
    };
    render();
    preview();
    const result = await pending;
    nativePreview.clear();
    configuredPreview.clear();
    if (modal.generation !== generation + 1 || !result) return false;
    selected = result.native;
    return true;
  }
  return {
    close,
    current,
    choose,
    reference: () => (selected ? { ...selected } : null),
    update: (values: NativeThemeSummary[]) => {
      templates = values;
    },
    reset() {
      close();
      templates = [];
      selected = null;
    },
    engineChanged() {
      close();
      selected = null;
    },
  };
}
