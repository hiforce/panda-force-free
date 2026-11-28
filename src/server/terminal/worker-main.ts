import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";
import { errorCode } from "../../shared/errors.js";
import { terminalSocketPath } from "./relay.js";
import { resolveTerminalCwd } from "./session.js";
import { openLocalTerminal, terminalFrameLimit } from "./socket.js";

const socket = terminalSocketPath(process.env.PANDA_FORCE_TERMINAL_SOCKET ?? "");
const workspace = process.env.PANDA_FORCE_TERMINAL_WORKSPACE;
const uid = process.getuid?.();
if (
  !uid ||
  !workspace ||
  workspace === "/" ||
  (await realpath(workspace)) !== workspace ||
  !(await lstat(workspace)).isDirectory()
)
  throw new Error("The terminal worker requires a non-root account and a mounted workspace");
const directory = dirname(socket);
const directoryInfo = await lstat(directory);
if (
  !directoryInfo.isDirectory() ||
  directoryInfo.uid !== uid ||
  directoryInfo.mode & 0o027 ||
  (await realpath(directory)) !== directory
)
  throw new Error("The terminal worker socket directory requires private permissions");

const originalUmask = process.umask(0o077);
try {
  const previous = await lstat(socket);
  if (!previous.isSocket() || previous.uid !== uid) throw new Error("Unsafe existing terminal worker socket");
  const listening = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(socket);
    probe.setTimeout(1000, () => {
      probe.destroy();
      reject(new Error("Terminal worker socket did not respond"));
    });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error) => {
      if (errorCode(error) === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
  if (listening) throw new Error("A terminal worker is already listening");
  await unlink(socket);
} catch (error) {
  if (errorCode(error) !== "ENOENT") throw error;
}

const terminals = new WebSocketServer({ noServer: true, maxPayload: terminalFrameLimit });
const server = createServer((req, res) => {
  const ready = req.method === "GET" && req.url === "/health/readiness";
  res.writeHead(ready ? 200 : 404);
  res.end();
});
server.on("upgrade", (req, socket, head) => {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/terminal" || terminals.clients.size >= 32) {
    socket.destroy();
    return;
  }
  const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), [workspace], workspace);
  terminals.handleUpgrade(req, socket, head, (client) => {
    try {
      openLocalTerminal(client, cwd);
    } catch {
      client.close(1011, "Terminal unavailable");
    }
  });
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(socket, () => {
    server.off("error", reject);
    resolve();
  });
});
await chmod(socket, 0o660);
process.umask(originalUmask);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    for (const client of terminals.clients) client.terminate();
    terminals.close();
    server.close();
    server.closeAllConnections();
  });
