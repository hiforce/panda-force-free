import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { errorStatus } from "../../shared/errors.js";
import type { PasswordAuth } from "../auth/contracts.js";
import type { RuntimeServices } from "../services.js";
import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from "../terminal/session.js";

/** Owns authenticated browser sockets, terminal workers and SSE keepalives. */
export function installBrowserConnections({
  server,
  browserWire,
  cluster,
  idaasAuth,
  passwordAuth,
  clients,
  sseClients,
  pendingEngineRequests,
  projectVisibility,
  engineDriver,
  browseRoots,
  defaultCwd,
  handleClient,
}: Pick<
  RuntimeServices,
  | "browserWire"
  | "cluster"
  | "idaasAuth"
  | "clients"
  | "sseClients"
  | "pendingEngineRequests"
  | "projectVisibility"
  | "engineDriver"
  | "browseRoots"
  | "defaultCwd"
> & {
  server: Server;
  passwordAuth: PasswordAuth;
  handleClient: (client: WebSocket, message: unknown) => Promise<void>;
}) {
  const terminalSessions = new Map<WebSocket, ReturnType<typeof createTerminalSession>>();
  const sseKeepalive = setInterval(() => {
    for (const client of sseClients) if (!client.writableEnded) client.write(": keepalive\n\n");
  }, 25_000);
  sseKeepalive.unref();

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
  });
  const terminalWss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    let idaasSession: { id: string } | null = null;
    let status = 401;
    let verified = false;
    try {
      await cluster?.verify(req, true);
      if (idaasAuth) idaasSession = await idaasAuth.authenticate(req);
      verified = true;
    } catch (error) {
      status = errorStatus(error, 503);
    }
    if (
      !verified ||
      (pathname !== "/ws" && pathname !== "/terminal") ||
      (idaasAuth ? !idaasSession : !passwordAuth.isAuthorized(req))
    ) {
      const body = JSON.stringify({ error: "Authentication required" });
      // Reconnect failures must not trigger browser-native Basic authentication prompts.
      socket.end(
        [
          `HTTP/1.1 ${status} ${status === 503 ? "Service Unavailable" : status === 403 ? "Forbidden" : "Unauthorized"}`,
          "Connection: close",
          "Content-Type: application/json; charset=utf-8",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "X-Content-Type-Options: nosniff",
          "",
          body,
        ].join("\r\n"),
      );
      return;
    }
    if (socket.destroyed) return;
    const target = pathname === "/terminal" ? terminalWss : wss;
    target.handleUpgrade(req, socket, head, (client) => {
      if (idaasAuth && idaasSession) {
        const unwatch = idaasAuth.watch(idaasSession.id, () => client.terminate());
        client.once("close", unwatch);
      }
      if (!idaasAuth) {
        const unwatch = passwordAuth.watch(req, () => client.terminate());
        client.once("close", unwatch);
      }
      target.emit("connection", client, req);
    });
  });
  wss.on("connection", (client) => {
    browserWire.register(client, client.protocol === "panda-engine-v1");
    clients.add(client);
    client.send(JSON.stringify({ type: "projects/visibility", ...projectVisibility.snapshot() }));
    client.send(JSON.stringify({ type: "bridge/status", status: engineDriver.connected ? "connected" : "connecting" }));
    for (const payload of pendingEngineRequests.values())
      client.send(browserWire.stringify(client, { type: "engine/request", payload }));
    client.on("message", (raw) => {
      try {
        handleClient(client, JSON.parse(String(raw)));
      } catch (error) {
        client.send(JSON.stringify({ type: "rpc/error", error: String(error) }));
      }
    });
    client.on("close", () => clients.delete(client));
  });
  terminalWss.on("connection", (client, req) => {
    let terminal: ReturnType<typeof createTerminalSession> | null = null;
    try {
      const url = new URL(req.url || "/terminal", "http://localhost");
      const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), browseRoots, defaultCwd);
      terminal = createTerminalSession({
        cwd,
        cols: 100,
        rows: 24,
        onData: (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(data);
        },
        onExit: (event) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(`\r\n[Process exited ${event.exitCode}]\r\n`);
            client.close(1000, "Terminal exited");
          }
        },
      });
      terminalSessions.set(client, terminal);
    } catch (error) {
      console.error("[panda-force] terminal failed", error);
      client.close(1011, "Terminal unavailable");
      return;
    }
    client.on("message", (raw, isBinary) => {
      if (
        !terminal ||
        (Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength) > 1_000_000
      )
        return;
      if (isBinary) {
        terminal.write(Buffer.from(raw as Buffer).toString("utf8"));
        return;
      }
      try {
        const resize = normalizeTerminalResize(JSON.parse(String(raw)));
        if (resize) terminal.resize(resize.cols, resize.rows);
      } catch {
        /* Terminal input is sent as binary; ignore malformed control frames. */
      }
    });
    client.on("close", () => {
      terminalSessions.delete(client);
      terminal?.kill();
      terminal = null;
    });
    client.on("error", () => client.close());
  });

  return {
    close() {
      clearInterval(sseKeepalive);
      for (const client of clients) client.terminate();
      clients.clear();
      for (const client of sseClients) client.end();
      sseClients.clear();
      wss.close();
      for (const [client, terminal] of terminalSessions) {
        terminal.kill();
        client.terminate();
      }
      terminalSessions.clear();
      terminalWss.close();
    },
  };
}
