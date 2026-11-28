import type { RawData } from "ws";
import { WebSocket } from "ws";
import { createTerminalSession, normalizeTerminalResize } from "./session.js";

export const terminalFrameLimit = 1024 * 1024;

export const terminalFrameSize = (data: RawData) =>
  Array.isArray(data) ? data.reduce((total, part) => total + part.length, 0) : data.byteLength;

/** Shared by the built-in terminal and the separate terminal worker. */
export function openLocalTerminal(client: WebSocket, cwd: string) {
  const terminal = createTerminalSession({
    cwd,
    cols: 100,
    rows: 24,
    onData(data) {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > terminalFrameLimit) client.close(1011, "Terminal output exceeded the buffer");
      else client.send(data);
    },
    onExit({ exitCode }) {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(`\r\n[Process exited ${exitCode}]\r\n`);
      client.close(1000, "Terminal exited");
    },
  });
  client.on("message", (raw, binary) => {
    if (terminalFrameSize(raw) > terminalFrameLimit) return;
    if (binary) {
      if (Buffer.isBuffer(raw)) terminal.write(raw.toString("utf8"));
      return;
    }
    try {
      const resize = normalizeTerminalResize(JSON.parse(String(raw)));
      if (resize) terminal.resize(resize.cols, resize.rows);
    } catch {
      /* Terminal input uses binary frames. */
    }
  });
  client.once("close", () => terminal.kill());
  client.on("error", () => client.terminate());
  return () => terminal.kill();
}
