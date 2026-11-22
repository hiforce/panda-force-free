import {
  REMOTE_TERMINAL_SOCKET,
  REMOTE_TOOL_PATH,
  type RemoteTerminalMessage,
} from "../../shared/workspace-tools/remote.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { busyIndicator } from "../busy-indicator.js";
import { requireElement } from "../dom.js";
import { localizeText, messageAttributes, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { remoteApi, RemoteApiError } from "./remote-api.js";

const FONT_SIZE = { minimum: 11, initial: 13, maximum: 18 } as const;

export function mountRemoteConsole(root: HTMLElement, id: string, t: Translate) {
  const msg = (key: MessageId) => messageHtml(key, undefined, t);
  setMessageHtml(
    root,
    `<section class="remote-console" aria-labelledby="remote-console-title">
    <header class="remote-console-header">
      <div class="remote-console-identity">
        <span class="remote-console-marks" aria-hidden="true"><i></i><i></i><i></i></span>
        <div><h1 id="remote-console-title">${msg("remoteTools.sshTerminal")}</h1><p data-remote-address hidden></p></div>
      </div>
      <div class="remote-console-actions">
        <div class="remote-console-status" role="status" data-state="connecting">${busyIndicator}<span>${msg("remoteTools.connecting")}</span></div>
        <button type="button" class="wb-button" data-remote-reconnect disabled>${msg("remoteTools.reconnect")}</button>
        <button type="button" class="wb-button" data-remote-close>${msg("common.close")}</button>
      </div>
    </header>
    <div class="remote-console-screen">
      <p class="remote-console-error" role="alert" hidden></p>
      <div class="remote-console-host"></div>
    </div>
    <footer class="remote-console-footer">
      <p>${msg("remoteTools.terminalHint")}</p>
      <div class="remote-console-font" role="group" ${messageAttributes("aria-label", "remoteTools.terminalFont", undefined, t)}>
        <button class="wb-button" type="button" data-remote-font-down ${messageAttributes("aria-label", "remoteTools.smallerTerminalFont", undefined, t)}>A−</button>
        <button class="wb-button remote-font-reset" type="button" data-remote-font-size ${messageAttributes("aria-label", "remoteTools.resetTerminalFont", undefined, t)}>${FONT_SIZE.initial}</button>
        <button class="wb-button" type="button" data-remote-font-up ${messageAttributes("aria-label", "remoteTools.largerTerminalFont", undefined, t)}>A+</button>
      </div>
    </footer>
  </section>`,
  );
  const host = requireElement(".remote-console-host", root) as HTMLElement,
    address = requireElement("[data-remote-address]", root) as HTMLElement,
    badge = requireElement(".remote-console-status", root) as HTMLElement,
    indicator = requireElement(".busy-indicator", badge) as HTMLElement,
    status = requireElement("span:last-child", badge) as HTMLElement,
    alert = requireElement(".remote-console-error", root) as HTMLElement,
    reconnect = requireElement("[data-remote-reconnect]", root) as HTMLButtonElement,
    close = requireElement("[data-remote-close]", root) as HTMLButtonElement,
    smaller = requireElement("[data-remote-font-down]", root) as HTMLButtonElement,
    larger = requireElement("[data-remote-font-up]", root) as HTMLButtonElement,
    resetFont = requireElement("[data-remote-font-size]", root) as HTMLButtonElement;
  const controller = new AbortController();
  let attempt: AbortController | undefined;
  let socket: WebSocket | undefined;
  let terminal: import("@xterm/xterm").Terminal | undefined;
  let resize: ResizeObserver | undefined;
  let fit: import("@xterm/addon-fit").FitAddon | undefined;
  let ready = false;
  let restarting = false;
  let fontSize: number = FONT_SIZE.initial;
  let phase: MessageId = "remoteTools.connecting";

  const showStatus = (key: MessageId) => {
    phase = key;
    const pending = key === "remoteTools.connecting";
    const connected = key === "remoteTools.connected";
    const failed = !pending && !connected && key !== "remoteTools.disconnected";
    badge.dataset.state = pending ? "connecting" : connected ? "connected" : failed ? "failed" : "disconnected";
    indicator.hidden = !pending;
    reconnect.disabled = pending;
    localizeText(status, failed ? "remoteTools.disconnected" : key, undefined, t);
    alert.hidden = !failed;
    if (failed) localizeText(alert, key, undefined, t);
  };
  const changeFont = (size: number) => {
    fontSize = Math.max(FONT_SIZE.minimum, Math.min(FONT_SIZE.maximum, size));
    resetFont.textContent = String(fontSize);
    smaller.disabled = fontSize === FONT_SIZE.minimum;
    larger.disabled = fontSize === FONT_SIZE.maximum;
    if (terminal) {
      terminal.options.fontSize = fontSize;
      fit?.fit();
    }
  };
  const sendSize = () => {
    if (!terminal || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: Math.max(20, Math.min(500, terminal.cols)),
        rows: Math.max(5, Math.min(200, terminal.rows)),
      }),
    );
  };
  const theme = () => {
    const style = getComputedStyle(host);
    return {
      background: style.backgroundColor,
      foreground: style.color,
      cursor: style.getPropertyValue("--pf-accent").trim(),
    };
  };

  async function connect() {
    if (controller.signal.aborted || attempt || socket) return;
    showStatus("remoteTools.connecting");
    ready = false;
    const request = new AbortController();
    attempt = request;
    try {
      const connection = await remoteApi.detail(id, request.signal);
      const runtime = terminal ? null : await import("/terminal-runtime.bundle.js");
      if (request.signal.aborted) return;
      const profile = connection.connection;
      const target = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
      setOpaqueText(address, `${profile.name} · ${profile.username}@${target}:${profile.port}`);
      address.title = address.textContent || "";
      address.hidden = false;
      if (runtime) {
        terminal = new runtime.Terminal({
          cursorBlink: true,
          cursorStyle: "block",
          fontFamily: getComputedStyle(host).getPropertyValue("--mono"),
          fontSize,
          lineHeight: 1.18,
          scrollback: 4000,
          theme: theme(),
        });
        fit = new runtime.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        terminal.onData((data) => {
          const current = socket;
          if (!ready || current?.readyState !== WebSocket.OPEN) return;
          const bytes = new TextEncoder().encode(data);
          for (let offset = 0; offset < bytes.length; offset += 32768)
            current.send(bytes.subarray(offset, offset + 32768));
        });
        terminal.onResize(sendSize);
        resize = new ResizeObserver(() => {
          if (host.clientWidth && host.clientHeight) fit?.fit();
        });
        resize.observe(host);
        terminal.writeln(t("remoteTools.terminalPreparing"));
      }
      terminal?.writeln("");
      terminal?.writeln(t("remoteTools.connecting"));
      const url = new URL(REMOTE_TERMINAL_SOCKET, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("id", id);
      const current = new WebSocket(url);
      socket = current;
      current.binaryType = "arraybuffer";
      current.onopen = sendSize;
      current.onmessage = ({ data }) => {
        if (socket !== current) return;
        if (data instanceof ArrayBuffer) {
          terminal?.write(new Uint8Array(data));
          return;
        }
        try {
          const message = JSON.parse(data) as RemoteTerminalMessage;
          if (message.type === "error") showStatus(`remoteTools.${message.code}`);
          if (message.type === "ready") {
            ready = true;
            showStatus("remoteTools.connected");
            terminal?.writeln(t("remoteTools.connected"));
            fit?.fit();
            sendSize();
            terminal?.focus();
          }
        } catch {
          /* Unexpected control frames do not enter the SSH output. */
        }
      };
      current.onclose = () => {
        if (socket !== current) return;
        socket = undefined;
        ready = false;
        if (restarting) {
          restarting = false;
          void connect();
          return;
        }
        if (phase === "remoteTools.connected") {
          showStatus("remoteTools.disconnected");
          terminal?.writeln(`\r\n${t("remoteTools.disconnected")}`);
        } else if (phase === "remoteTools.connecting") showStatus("remoteTools.connectionFailed");
      };
      current.onerror = () => current.close();
    } catch (error) {
      if (!request.signal.aborted)
        showStatus(error instanceof RemoteApiError ? error.messageId : "remoteTools.unavailable");
    } finally {
      if (attempt === request) attempt = undefined;
    }
  }

  reconnect.onclick = () => {
    if (!socket) {
      void connect();
      return;
    }
    restarting = true;
    ready = false;
    showStatus("remoteTools.connecting");
    socket.close();
  };
  smaller.onclick = () => changeFont(fontSize - 1);
  larger.onclick = () => changeFont(fontSize + 1);
  resetFont.onclick = () => changeFont(FONT_SIZE.initial);
  close.onclick = () => {
    dispose();
    window.close();
    window.setTimeout(() => {
      if (!window.closed) location.replace(REMOTE_TOOL_PATH);
    }, 80);
  };
  const dispose = () => {
    controller.abort();
    attempt?.abort();
    const current = socket;
    socket = undefined;
    current?.close();
    resize?.disconnect();
    terminal?.dispose();
  };
  const viewport = window.visualViewport;
  const syncViewport = () => {
    if (viewport && viewport.height > 0)
      root.style.setProperty("--remote-viewport-height", `${Math.floor(viewport.height)}px`);
  };
  viewport?.addEventListener("resize", syncViewport, { signal: controller.signal });
  syncViewport();
  window.addEventListener(
    "pagehide",
    () => {
      if (controller.signal.aborted) return;
      restarting = false;
      attempt?.abort();
      socket?.close();
      if (!socket) showStatus("remoteTools.disconnected");
    },
    { signal: controller.signal },
  );
  void connect();
  return dispose;
}
