import { bindMessages } from "../i18n.js";
import { renderAssistantMarkdown } from "../rendering.js";
import { closestElement, findElement } from "./../dom.js";

// Delegates global shell events after every feature interface has been assembled.
/** @param {import("./ports.js").FeatureOptions<"i18n" | "$" | "workspacePreparation" | "state" | "viewUpdates", "images" | "panels" | "localization" | "synchronization" | "sidebarLayout" | "usage" | "identity" | "models" | "settings" | "workbench" | "navigation", "bindings">} options */
export function assembleBindings({
  i18n,
  $,
  workspacePreparation,
  state,
  imagesPort,
  panelsPort,
  localizationPort,
  synchronizationPort,
  sidebarLayoutPort,
  usagePort,
  identityPort,
  modelsPort,
  viewUpdates,
  settingsPort,
  workbenchPort,
  navigationPort,
}) {
  function bind() {
    globalThis.__renderAssistantMarkdown = renderAssistantMarkdown;
    bindMessages(document);
    i18n.subscribe(() => workspacePreparation.refresh());
    addEventListener("pagehide", () => workspacePreparation.dispose(), {
      once: true,
    });

    i18n.subscribe(
      /** @param {Parameters<typeof localizationPort.refreshLocalizedRuntime>} args */ (...args) =>
        localizationPort.refreshLocalizedRuntime(...args),
    );
    localizationPort.refreshLocalizedRuntime();

    document.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null,
        image = closestElement("[data-image-src]", target);
      if (image) {
        e.preventDefault();
        imagesPort.openImageViewer(
          image.dataset.imageSrc || "",
          image.dataset.imageTitle || findElement("img", image)?.alt || "Image",
          image.dataset.imagePath || "",
        );
        return;
      }
      const citation = closestElement("a[data-file-reference]", target);
      if (!citation) return;
      e.preventDefault();
      const reference = {
        path: citation.dataset.fileReference,
        lineStart: Number(citation.dataset.fileLineStart) || null,
        lineEnd: Number(citation.dataset.fileLineEnd) || null,
      };
      dispatchEvent(new CustomEvent("panda-force:file-reference", { detail: reference }));
      panelsPort.filePreview.open({
        ...reference,
        cwd: citation.dataset.fileCwd || identityPort.imageCwd(),
      });
    });
    document.addEventListener("click", (e) => {
      const path = e.composedPath();
      if (
        sidebarLayoutPort.mobileSidebarEnabled() &&
        $("#sidebar").classList.contains("mobile-open") &&
        !path.includes($("#sidebar")) &&
        !path.includes($("#toggleSidebar")) &&
        !path.includes($("#workspaceNavigationToggle"))
      )
        sidebarLayoutPort.setSidebarOpen(false);
      if (!path.includes($("#modelPicker"))) modelsPort.closeModelMenu();
      if (!path.includes($("#permissionPicker"))) modelsPort.closePermissionMenu();
      if (!path.includes($("#accountMenu")) && !path.includes($("#accountButton")))
        viewUpdates.request("accountMenu", false);
      if (!path.includes($("#sidebarSearchPanel")) && !path.includes($("#sidebarSearchButton")))
        sidebarLayoutPort.setSidebarSearchOpen(false);
      if (!path.includes($("#sidebarHelpMenu")) && !path.includes($("#sidebarHelpButton")))
        sidebarLayoutPort.setSidebarHelpOpen(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        usagePort.pauseUsageRefresh();
        return;
      }
      if (usagePort.usagePageVisible()) usagePort.loadUsage();
      if (state.modelLoadStatus === "error") modelsPort.loadModels();
      synchronizationPort.resumeSessionSync();
    });
    addEventListener(
      "pageshow",
      /** @param {Parameters<typeof synchronizationPort.resumeSessionSync>} args */ (...args) =>
        synchronizationPort.resumeSessionSync(...args),
    );
    addEventListener(
      "focus",
      /** @param {Parameters<typeof synchronizationPort.resumeSessionSync>} args */ (...args) =>
        synchronizationPort.resumeSessionSync(...args),
    );

    addEventListener("resize", () => {
      panelsPort.syncOverlayPanelMode();
      sidebarLayoutPort.syncSidebarLayout();
      for (const terminalState of Object.values(panelsPort.terminalStates))
        requestAnimationFrame(() => panelsPort.fitTerminal(terminalState));
    });
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof Element && closestElement(".terminal-host", e.target)) return;
      if (e.key === "Escape") {
        if (panelsPort.filePreview.isOpen && !$("#imageViewer").open) {
          e.preventDefault();
          panelsPort.filePreview.close();
          return;
        }
        if ($("#imageViewer").open) {
          e.preventDefault();
          imagesPort.closeImageViewer();
          return;
        }
        if ($("#filesDialog").open) {
          e.preventDefault();
          panelsPort.closeFilesDialog();
          return;
        }
        if ($("#goalDialog").open || $("#folderDialog").open || $("#fullAccessDialog").open) return;
        if (e.defaultPrevented) return;
        if (!$("#sidebarSearchPanel").hidden) {
          e.preventDefault();
          sidebarLayoutPort.setSidebarSearchOpen(false);
          return;
        }
        if (!$("#sidebarHelpMenu").hidden) {
          e.preventDefault();
          sidebarLayoutPort.setSidebarHelpOpen(false);
          return;
        }
        if ($("#settingsDialog").open) {
          e.preventDefault();
          settingsPort.closeSettings();
          return;
        }
        modelsPort.closeModelMenu();
        modelsPort.closePermissionMenu();
        viewUpdates.request("accountMenu", false);
        if (document.body.classList.contains("side-panel-open")) panelsPort.setSidePanelOpen(false);
        else if (document.body.classList.contains("summary-panel-open")) panelsPort.setSummaryPanelOpen(false);
      }
      if (workbenchPort.workbench?.keyboard(e)) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        navigationPort.startNewTask();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        $("#toggleSidebar").click();
      }
    });
  }

  return {
    bind,
  };
}
