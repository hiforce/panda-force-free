import { getBrowserI18n, localizeText } from "./i18n.js";

const TERMINAL_RECONNECT_MS = 1000;

/**
 * Embedded terminal panel: xterm lifecycle, the /terminal WebSocket with
 * reconnect, and fit/resize propagation. The working directory and auth
 * re-check come from the app via callbacks.
 */
export function createTerminalPanel({ $, getCwd, onAuthCheck, t = getBrowserI18n().t }) {
  const createTerminalState = (hostId, panelId) => ({
    hostId,
    panelId,
    term: null,
    fit: null,
    ws: null,
    resizeObserver: null,
    reconnectTimer: null,
    loading: null,
  });
  const terminalStates = { side: createTerminalState("sideTerminalHost", "sidePanel") };

  function terminalIsVisible(terminalState) {
    const host = $(`#${terminalState.hostId}`),
      panel = $(`#${terminalState.panelId}`);
    return host && !host.hidden && panel && !panel.hidden;
  }
  function fitTerminal(terminalState) {
    const host = $(`#${terminalState.hostId}`);
    if (!terminalState.fit || !terminalIsVisible(terminalState) || host.clientWidth < 1 || host.clientHeight < 1)
      return;
    try {
      terminalState.fit.fit();
    } catch {}
  }
  function sendTerminalResize(terminalState) {
    const ws = terminalState.ws,
      term = terminalState.term;
    if (ws?.readyState === WebSocket.OPEN && term)
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
  function connectTerminal(terminalState) {
    if (terminalState.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(terminalState.ws.readyState)) return;
    clearTimeout(terminalState.reconnectTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:",
      host = $(`#${terminalState.hostId}`),
      ws = new WebSocket(`${proto}//${location.host}/terminal?cwd=${encodeURIComponent(getCwd())}`);
    terminalState.ws = ws;
    ws.binaryType = "arraybuffer";
    host.dataset.connected = "false";
    ws.onopen = () => {
      host.dataset.connected = "true";
      requestAnimationFrame(() => {
        fitTerminal(terminalState);
        sendTerminalResize(terminalState);
        terminalState.term?.focus();
      });
    };
    ws.onmessage = async (event) => {
      const data =
        event.data instanceof Blob
          ? new Uint8Array(await event.data.arrayBuffer())
          : event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : String(event.data);
      terminalState.term?.write(data);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      onAuthCheck();
      host.dataset.connected = "false";
      if (terminalState.ws === ws) terminalState.ws = null;
      if (terminalIsVisible(terminalState))
        terminalState.reconnectTimer = setTimeout(() => connectTerminal(terminalState), TERMINAL_RECONNECT_MS);
    };
  }
  async function initializeTerminal(terminalState) {
    if (terminalState.term) {
      connectTerminal(terminalState);
      requestAnimationFrame(() => fitTerminal(terminalState));
      return;
    }
    if (terminalState.loading) return terminalState.loading;
    terminalState.loading = import("/terminal-runtime.bundle.js")
      .then(({ Terminal, FitAddon }) => {
        if (!terminalIsVisible(terminalState)) return;
        const dark = matchMedia("(prefers-color-scheme:dark)").matches,
          host = $(`#${terminalState.hostId}`),
          term = new Terminal({
            cursorBlink: true,
            cursorStyle: "block",
            fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',
            fontSize: 13,
            lineHeight: 1.2,
            scrollback: 5000,
            theme: dark
              ? { background: "#181818", foreground: "#f2f2f2", cursor: "#f2f2f2", selectionBackground: "#3b4a5a" }
              : { background: "#ffffff", foreground: "#0d0d0d", cursor: "#0d0d0d", selectionBackground: "#c8dcf4" },
          }),
          fit = new FitAddon();
        term.loadAddon(fit);
        host.replaceChildren();
        term.open(host);
        terminalState.term = term;
        terminalState.fit = fit;
        term.onData((data) => {
          const ws = terminalState.ws;
          if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
        });
        term.onResize(() => sendTerminalResize(terminalState));
        terminalState.resizeObserver = new ResizeObserver(() =>
          requestAnimationFrame(() => fitTerminal(terminalState)),
        );
        terminalState.resizeObserver.observe(host);
        connectTerminal(terminalState);
        globalThis.__codexTerminals = terminalStates;
      })
      .catch(() => {
        localizeText($(`#${terminalState.hostId}`), "errors.couldNotLoadTerminalCloseAndReopenToRetry", undefined, t);
        onAuthCheck();
      })
      .finally(() => {
        terminalState.loading = null;
      });
    return terminalState.loading;
  }

  return { terminalStates, fitTerminal, initializeTerminal };
}
