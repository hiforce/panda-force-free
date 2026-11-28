import type { RawData } from "ws";
import { WebSocket } from "ws";
import { terminalFrameLimit, terminalFrameSize } from "./socket.js";

export function terminalSocketPath(path: string) {
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.sock$/.test(path) || Buffer.byteLength(path) > 100)
    throw new Error("The terminal worker requires an absolute Unix socket path");
  return path;
}

export function openTerminalRelay(client: WebSocket, socketPath: string, cwd: string) {
  const query = new URLSearchParams({ cwd });
  const upstream = new WebSocket(`ws+unix://${terminalSocketPath(socketPath)}:/terminal?${query}`, {
    handshakeTimeout: 5000,
    maxPayload: terminalFrameLimit,
    perMessageDeflate: false,
  });
  let bufferedBytes = 0;
  let stopped = false;
  const pending: { raw: RawData; binary: boolean }[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    pending.length = 0;
    bufferedBytes = 0;
    upstream.terminate();
  };
  const finish = (code: 1000 | 1011) => {
    if (stopped) return;
    stop();
    if (client.readyState === WebSocket.OPEN)
      client.close(code, code === 1000 ? "Terminal exited" : "Terminal unavailable");
  };
  function send(target: WebSocket, raw: RawData, binary: boolean) {
    if (target.readyState !== WebSocket.OPEN) return;
    if (target.bufferedAmount + terminalFrameSize(raw) > terminalFrameLimit) return finish(1011);
    target.send(raw, { binary });
  }
  upstream.once("open", () => {
    for (const { raw, binary } of pending) send(upstream, raw, binary);
    pending.length = 0;
    bufferedBytes = 0;
  });
  upstream.on("error", () => finish(1011));
  upstream.once("close", (code) => finish(code === 1000 ? 1000 : 1011));
  upstream.on("message", (raw, binary) => send(client, raw, binary));
  client.on("message", (raw, binary) => {
    if (upstream.readyState !== WebSocket.CONNECTING) return send(upstream, raw, binary);
    bufferedBytes += terminalFrameSize(raw);
    if (bufferedBytes > terminalFrameLimit || pending.length >= 64) return finish(1011);
    pending.push({ raw, binary });
  });
  client.once("close", stop);
  client.on("error", stop);
  return stop;
}
