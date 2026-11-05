import {
  getBrowserI18n,
  localizeAttribute,
  localizeText,
  setMessageHtml,
  setOpaqueAttribute,
  setOpaqueText,
} from "./i18n.js";

import { localDownloadUrl, renderAssistantMarkdown } from "./rendering.js";
import { createCodeViewer, languageName } from "./code-viewer.js";
import { configureAttachmentUrls } from "../shared/attachment-urls.js";

// Keep source previews bounded before syntax parsing and layout work begin.
const TEXT_MAX_BYTES = 512 * 1024;
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const MAX_LINES = 20000;
// Normal source files use CodeMirror's incremental highlighting. Bound total
// input and individual lines to keep large/minified files responsive on mobile.
const MAX_HIGHLIGHT_BYTES = 256 * 1024;
const MAX_HIGHLIGHT_LINE = 8 * 1024;
const MAX_OPEN_TABS = 9;

// Read through the existing authenticated file endpoint without navigating to it.
async function readPreview(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("This file is too large to preview.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("This file is too large to preview.");
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

export function createFilePreview({
  t = getBrowserI18n().t,
  onBackToFiles = () => {},
  getAttachmentUrlPrefix = () => "",
} = {}) {
  configureAttachmentUrls(getAttachmentUrlPrefix());
  if (!document.querySelector("#filePreviewStyles")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "filePreviewStyles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/file-preview.css";
    document.head.append(stylesheet);
  }
  const dialog = document.createElement("dialog");
  dialog.id = "filePreview";
  dialog.className = "file-preview";
  dialog.setAttribute("aria-labelledby", "filePreviewTitle");
  setMessageHtml(
    dialog,
    `<div class="file-preview-shell">
    <header class="file-preview-header">
      <div class="file-preview-heading"><strong id="filePreviewTitle"></strong><small id="filePreviewPath"></small></div>
      <button id="backToFiles" class="file-preview-back" type="button">‹</button><a id="filePreviewDownload"></a><button id="closeFilePreview" type="button">×</button>
    </header>
    <nav class="file-preview-tabs" aria-label="Open files" data-pf-aria-label="common.openFiles"><button id="closeAllFileTabs" class="file-preview-close-all" type="button"></button></nav>
    <div class="file-preview-toolbar" hidden>
      <button type="button" data-file-view="preview"></button><button type="button" data-file-view="source"></button><button type="button" data-file-view="diff" hidden></button><button type="button" data-file-view="history" hidden></button>
      <span class="file-preview-toolbar-spacer"></span>
      <button type="button" data-file-action="find"></button><button type="button" data-file-action="wrap" aria-pressed="false"></button><button type="button" data-file-action="copy"></button>
      <span class="file-preview-language"></span><span class="file-preview-readonly"></span>
    </div>
    <div id="filePreviewContent" class="file-preview-content" aria-busy="false"></div>
  </div>`,
  );
  document.body.append(dialog);
  const title = dialog.querySelector("#filePreviewTitle");
  const pathLabel = dialog.querySelector("#filePreviewPath");
  const download = dialog.querySelector("#filePreviewDownload");
  const closeButton = dialog.querySelector("#closeFilePreview");
  const backButton = dialog.querySelector("#backToFiles");
  const tabsHost = dialog.querySelector(".file-preview-tabs");
  const closeAllButton = dialog.querySelector("#closeAllFileTabs");
  const toolbar = dialog.querySelector(".file-preview-toolbar");
  const content = dialog.querySelector("#filePreviewContent");
  const viewButtons = [...toolbar.querySelectorAll("[data-file-view]")];
  const findButton = toolbar.querySelector('[data-file-action="find"]');
  const wrapButton = toolbar.querySelector('[data-file-action="wrap"]');
  const copyButton = toolbar.querySelector('[data-file-action="copy"]');
  const languageLabel = toolbar.querySelector(".file-preview-language");
  const readonlyLabel = toolbar.querySelector(".file-preview-readonly");
  let request = null,
    gitRequest = null,
    objectUrl = "",
    returnFocus = null,
    editor = null,
    copyResetTimer = null;
  let wrap = globalThis.matchMedia?.("(max-width:720px), (pointer:coarse)").matches ?? false;
  const tabs = [];
  let activeTab = null;

  function closeAllTabs() {
    tabs.splice(0, tabs.length);
    activeTab = null;
    release();
    renderTabs();
    close();
  }

  function renderTabs() {
    tabsHost.replaceChildren(closeAllButton);
    localizeText(closeAllButton, "files.closeAll", undefined, t);
    closeAllButton.hidden = tabs.length === 0;
    for (const tab of tabs) {
      const item = document.createElement("div");
      item.className = `file-preview-tab${tab === activeTab ? " active" : ""}`;
      const button = document.createElement("button");
      button.type = "button";
      setOpaqueText(button, tab.name);
      setOpaqueAttribute(button, "title", tab.path);
      button.onclick = () => open(tab);
      const closeTab = document.createElement("button");
      closeTab.type = "button";
      closeTab.className = "file-preview-tab-close";
      setOpaqueText(closeTab, "×");
      closeTab.setAttribute("aria-label", `${t("common.close")} ${tab.name}`);
      closeTab.onclick = (event) => {
        event.stopPropagation();
        const index = tabs.indexOf(tab);
        tabs.splice(index, 1);
        if (tab === activeTab) {
          const next = tabs[index] || tabs[index - 1];
          if (next) open(next);
          else close();
        }
        renderTabs();
      };
      item.append(button, closeTab);
      tabsHost.append(item);
    }
  }

  function release() {
    request?.abort();
    gitRequest?.abort();
    request = null;
    editor?.destroy();
    editor = null;
    clearTimeout(copyResetTimer);
    content.replaceChildren();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    content.setAttribute("aria-busy", "false");
  }
  function status(message) {
    const element = document.createElement("p");
    element.className = "file-preview-status";
    element.setAttribute("role", "status");
    localizeText(element, message, undefined, t);
    content.replaceChildren(element);
  }
  function close() {
    if (dialog.open) dialog.close();
  }
  closeButton.onclick = close;
  backButton.onclick = () => {
    close();
    onBackToFiles();
  };
  dialog.addEventListener("click", (event) => {
    // On desktop the transparent preview backdrop sits over the file tree as
    // part of one workspace. Clicking the tree or its empty area must not
    // close the active file.
    if (event.target === dialog && !document.body.classList.contains("files-workspace")) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    release();
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  });

  function renderDiff(diff) {
    const pre = document.createElement("pre");
    pre.className = "file-preview-diff";
    for (const line of String(diff || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")) {
      const row = document.createElement("div");
      row.className =
        line.startsWith("+") && !line.startsWith("+++")
          ? "diff-add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "diff-delete"
            : line.startsWith("@@") || line.startsWith("diff ")
              ? "diff-header"
              : "diff-context";
      setOpaqueText(row, line || " ");
      pre.append(row);
    }
    content.replaceChildren(pre);
  }

  async function loadGit(kind, details) {
    gitRequest?.abort();
    const controller = new AbortController();
    gitRequest = controller;
    try {
      const params = new URLSearchParams({ cwd: details.cwd, path: details.gitStatus?.repoPath || details.path });
      if (kind === "history") params.set("limit", "50");
      else {
        params.set("scope", details.scope || "head");
        if (details.commit) params.set("commit", details.commit);
      }
      const response = await fetch(`/api/git/${kind}?${params}`, { signal: controller.signal, cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Git data unavailable");
      if (request !== details.controller || controller.signal.aborted) return;
      if (kind === "diff") {
        renderDiff(result.diff);
        return;
      }
      const list = document.createElement("div");
      list.className = "file-history-list";
      if (!result.items?.length) {
        status("No Git history found.");
        return;
      }
      for (const item of result.items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-history-item";
        const date = new Date(item.date);
        setMessageHtml(button, `<strong></strong><small></small><time></time>`);
        setOpaqueText(button.querySelector("strong"), `${item.shortHash} ${item.subject}`);
        setOpaqueText(button.querySelector("small"), item.author);
        setOpaqueText(
          button.querySelector("time"),
          Number.isNaN(date.valueOf()) ? item.date : getBrowserI18n().format.dateTime(date),
        );
        button.onclick = () =>
          loadGit("diff", { ...details, scope: "commit", commit: item.hash, controller: details.controller });
        list.append(button);
      }
      content.replaceChildren(list);
    } catch (error) {
      if (!controller.signal.aborted) status(error.message || "Git data unavailable");
    }
  }

  function showText(text, { path, cwd, lineStart, lineEnd, gitStatus }, controller) {
    const markdown = /\.(?:md|markdown|mdown)$/i.test(path);
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const syntaxHighlight =
      new TextEncoder().encode(text).byteLength <= MAX_HIGHLIGHT_BYTES &&
      lines.every((line) => line.length <= MAX_HIGHLIGHT_LINE);
    toolbar.hidden = false;
    viewButtons.forEach((button) => {
      button.hidden =
        button.dataset.fileView === "diff" || button.dataset.fileView === "history" ? !gitStatus : !markdown;
    });
    findButton.hidden = true;
    wrapButton.hidden = true;
    copyButton.hidden = true;
    setOpaqueText(languageLabel, languageName(path));
    localizeText(readonlyLabel, "files.readOnly", undefined, t);
    const render = (mode) => {
      content.scrollTop = 0;
      viewButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.fileView === mode)));
      editor?.destroy();
      editor = null;
      if (mode === "diff") {
        findButton.hidden = true;
        wrapButton.hidden = true;
        copyButton.hidden = true;
        loadGit("diff", { path, cwd, gitStatus, controller });
        return;
      }
      if (mode === "history") {
        findButton.hidden = true;
        wrapButton.hidden = true;
        copyButton.hidden = true;
        loadGit("history", { path, cwd, gitStatus, controller });
        return;
      }
      if (mode === "preview") {
        findButton.hidden = true;
        wrapButton.hidden = true;
        copyButton.hidden = true;
        const article = document.createElement("article");
        article.className = "message-text file-preview-markdown";
        setMessageHtml(article, renderAssistantMarkdown(text, { cwd }));
        content.replaceChildren(article);
        return;
      }
      findButton.hidden = false;
      wrapButton.hidden = false;
      copyButton.hidden = false;
      localizeText(findButton, "files.find", undefined, t);
      localizeAttribute(findButton, "aria-label", "files.findInFile", undefined, t);
      setOpaqueText(wrapButton, wrap ? t("files.unwrap") : t("files.wrap"));
      wrapButton.setAttribute("aria-label", wrap ? t("files.disableWordWrap") : t("files.enableWordWrap"));
      wrapButton.setAttribute("aria-pressed", String(wrap));
      localizeText(copyButton, "files.copy", undefined, t);
      localizeAttribute(copyButton, "aria-label", "files.copyFile", undefined, t);
      const host = document.createElement("div");
      host.className = "file-preview-editor";
      content.replaceChildren(host);
      editor = createCodeViewer(host, {
        text: lines.slice(0, MAX_LINES).join("\n"),
        path,
        lineStart,
        lineEnd,
        wrap,
        syntaxHighlight,
      });
      findButton.onclick = () => editor?.find();
      wrapButton.onclick = () => {
        wrap = !wrap;
        editor?.setWrap(wrap);
        setOpaqueText(wrapButton, wrap ? t("files.unwrap") : t("files.wrap"));
        wrapButton.setAttribute("aria-label", wrap ? t("files.disableWordWrap") : t("files.enableWordWrap"));
        wrapButton.setAttribute("aria-pressed", String(wrap));
      };
      copyButton.onclick = async () => {
        try {
          await editor?.copy();
          localizeText(copyButton, "common.copied", undefined, t);
          clearTimeout(copyResetTimer);
          copyResetTimer = setTimeout(() => {
            if (copyButton.isConnected) localizeText(copyButton, "files.copy", undefined, t);
          }, 1400);
        } catch {
          localizeText(copyButton, "files.copyFailed", undefined, t);
          clearTimeout(copyResetTimer);
          copyResetTimer = setTimeout(() => {
            if (copyButton.isConnected) localizeText(copyButton, "files.copy", undefined, t);
          }, 1800);
        }
      };
      if (lines.length > MAX_LINES) {
        const notice = document.createElement("p");
        notice.className = "file-preview-status";
        localizeText(notice, "files.onlyTheFirst20000LinesAreShown", undefined, t);
        content.append(notice);
      }
      if (
        !syntaxHighlight &&
        /\.(?:js|jsx|ts|tsx|json|jsonc|md|markdown|mdown|css|html|htm|py|rs|sql|xml|svg)$/i.test(path)
      ) {
        const notice = document.createElement("p");
        notice.className = "file-preview-status file-preview-performance-notice";
        localizeText(notice, "files.syntaxHighlightingWasDisabledForThisLargeFileToKeep", undefined, t);
        content.append(notice);
      }
      requestAnimationFrame(() => {
        if (request === controller && dialog.open) editor?.revealLines(lineStart, lineEnd);
      });
    };
    for (const button of viewButtons) {
      localizeText(
        button,
        button.dataset.fileView === "preview"
          ? "common.preview"
          : button.dataset.fileView === "source"
            ? "common.source"
            : button.dataset.fileView === "diff"
              ? "common.diff"
              : "common.history",
        undefined,
        t,
      );
      button.onclick = () => render(button.dataset.fileView);
    }
    render(markdown && !lineStart ? "preview" : "source");
  }

  async function open({ path, cwd = "", lineStart = null, lineEnd = null, gitStatus = null }) {
    if (!path) return;
    if (!dialog.open) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const tab = arguments[0];
    let existing = tabs.find((item) => item.path === path && item.cwd === cwd);
    if (!existing && tabs.length >= MAX_OPEN_TABS) {
      status("common.youCanOpenUpTo9FilesAtOnceClose");
      return;
    }
    if (!existing) {
      existing = { path, cwd, lineStart, lineEnd, gitStatus, name: path.split(/[\\/]/).at(-1) || path };
      tabs.push(existing);
    } else Object.assign(existing, { lineStart, lineEnd, gitStatus });
    activeTab = existing;
    renderTabs();
    release();
    const controller = new AbortController();
    request = controller;
    let filename = path.split(/[\\/]/).at(-1) || path;
    try {
      filename = decodeURIComponent(filename);
    } catch {
      /* Preserve literal filenames. */
    }
    setOpaqueText(title, filename);
    setOpaqueText(pathLabel, `${path}${lineStart ? `:${lineStart}${lineEnd ? `-${lineEnd}` : ""}` : ""}`);
    localizeText(download, "files.download", undefined, t);
    download.href = localDownloadUrl(path, cwd);
    download.download = filename;
    localizeAttribute(closeButton, "aria-label", "files.closeFilePreview", undefined, t);
    localizeAttribute(backButton, "aria-label", "files.backToFiles", undefined, t);
    toolbar.hidden = true;
    status("common.loadingFile");
    content.setAttribute("aria-busy", "true");
    if (!dialog.open) {
      // The desktop workspace already has the files dialog as its modal
      // surface. Keep the content pane non-modal so the tree remains
      // interactive while the pane is open.
      if (document.body.classList.contains("files-workspace")) dialog.show();
      else dialog.showModal();
    }
    closeButton.focus();
    try {
      const response = await fetch(download.href, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("File unavailable");
      const pdf = /\.pdf$/i.test(filename);
      const blob = await readPreview(response, pdf ? PDF_MAX_BYTES : TEXT_MAX_BYTES);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (request !== controller || !dialog.open) return;
      if (pdf && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
        if (!navigator.pdfViewerEnabled) throw new Error("PDF preview is not available in this browser.");
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const frame = document.createElement("iframe");
        frame.className = "file-preview-pdf";
        setOpaqueAttribute(frame, "title", filename);
        frame.src = objectUrl;
        content.replaceChildren(frame);
      } else {
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("Preview is not available for this file type.");
        }
        if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error("Preview is not available for this file type.");
        showText(text, { path, cwd, lineStart, lineEnd, gitStatus }, controller);
      }
    } catch (error) {
      if (request === controller && !controller.signal.aborted) status(error.message || "File unavailable");
    } finally {
      if (request === controller) content.setAttribute("aria-busy", "false");
    }
  }
  closeAllButton.onclick = closeAllTabs;
  return {
    open,
    close,
    get isOpen() {
      return dialog.open;
    },
  };
}
