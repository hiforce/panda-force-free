import { browserSandboxFor, normalizeBrowserUrl } from "./browser-panel.js";
import { localizeText } from "./i18n.js";

const BROWSER_LOAD_TIMEOUT_MS = 10000;

/**
 * Embedded browser panel: URL normalization, iframe loading with sandbox and
 * timeout handling, and the back/forward history. Panel opening stays in the
 * app shell (it touches the side-panel layout).
 */
export function createBrowserController({ $ }) {
  /** @type {{history: string[]; index: number; loadTimer: ReturnType<typeof setTimeout> | null; loadRequest: number}} */
  const browserState = { history: [], index: -1, loadTimer: null, loadRequest: 0 };

  function setBrowserStatus(text, tone = "ready") {
    const status = $("#browserStatus");
    status.dataset.tone = tone;
    localizeText($("#browserStatusText"), text);
  }
  function updateBrowserControls() {
    const current = browserState.history[browserState.index] || "";
    $("#browserBack").disabled = browserState.index <= 0;
    $("#browserForward").disabled = browserState.index < 0 || browserState.index >= browserState.history.length - 1;
    $("#browserRefresh").disabled = !current;
    for (const link of [$("#browserOpenExternal"), $("#browserNoticeExternal")]) {
      link.hidden = !current;
      if (current) link.href = current;
    }
  }
  function showBrowserNotice(title, description) {
    localizeText($("#browserNoticeTitle"), title);
    localizeText($("#browserNoticeDescription"), description);
    $("#browserNotice").hidden = false;
    $("#browserLoading").hidden = true;
    $("#browserFrameShell").setAttribute("aria-busy", "false");
    setBrowserStatus(title, "error");
  }
  function finishBrowserLoad(requestId) {
    if (requestId !== browserState.loadRequest) return;
    clearTimeout(browserState.loadTimer ?? undefined);
    $("#browserLoading").hidden = true;
    $("#browserNotice").hidden = true;
    $("#browserFrameShell").setAttribute("aria-busy", "false");
    setBrowserStatus("common.browserLoaded", "loaded");
  }
  function navigateBrowser(value, { push = true } = {}) {
    const result = normalizeBrowserUrl(value);
    if (!result.url) {
      showBrowserNotice("common.invalidBrowserAddress", result.messageId);
      $("#browserUrl").setAttribute("aria-invalid", "true");
      return false;
    }
    const url = result.url;
    $("#browserUrl").removeAttribute("aria-invalid");
    $("#browserUrl").value = url;
    if (push && browserState.history[browserState.index] !== url) {
      browserState.history = browserState.history.slice(0, browserState.index + 1);
      browserState.history.push(url);
      browserState.index = browserState.history.length - 1;
    }
    const requestId = ++browserState.loadRequest,
      frame = $("#browserFrame");
    clearTimeout(browserState.loadTimer ?? undefined);
    $("#browserEmpty").hidden = true;
    $("#browserNotice").hidden = true;
    $("#browserLoading").hidden = false;
    frame.hidden = false;
    frame.setAttribute("sandbox", browserSandboxFor(url, location.href));
    $("#browserFrameShell").setAttribute("aria-busy", "true");
    setBrowserStatus("common.loadingPage", "loading");
    updateBrowserControls();
    frame.onload = () => finishBrowserLoad(requestId);
    frame.onerror = () =>
      requestId === browserState.loadRequest &&
      showBrowserNotice("common.browserLoadFailed", "common.browserLoadFailedDetail");
    frame.src = url;
    browserState.loadTimer = setTimeout(() => {
      if (requestId === browserState.loadRequest)
        showBrowserNotice("common.browserEmbeddingBlocked", "common.browserEmbeddingBlockedDetail");
    }, BROWSER_LOAD_TIMEOUT_MS);
    return true;
  }
  function moveBrowserHistory(delta) {
    const next = browserState.index + delta;
    if (next < 0 || next >= browserState.history.length) return;
    browserState.index = next;
    navigateBrowser(browserState.history[next], { push: false });
    updateBrowserControls();
  }

  return { browserState, navigateBrowser, moveBrowserHistory, updateBrowserControls };
}
