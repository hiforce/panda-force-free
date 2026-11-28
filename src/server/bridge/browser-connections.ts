import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { ProjectVisibility } from "../../shared/engine/types.js";
import { errorStatus } from "../../shared/errors.js";
import type { PasswordAuth } from "../auth/contracts.js";
import type { RuntimeServices } from "../services.js";
import { resolveTerminalCwd } from "../terminal/session.js";
import { openLocalTerminal, terminalFrameLimit } from "../terminal/socket.js";
import { openTerminalRelay } from "../terminal/relay.js";
import { sharedWorkspaceAllowed } from "../auth/users/access.js";
import { matchesRequestOrigin } from "../auth/origin.js";
import { REMOTE_TERMINAL_SOCKET } from "../../shared/workspace-tools/remote.js";

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
  openRemoteTerminal,
  terminalSocket,
  allowLocalTerminal = true,
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
  openRemoteTerminal?: (client: WebSocket, request: IncomingMessage, url: URL) => Promise<void>;
  terminalSocket?: string;
  allowLocalTerminal?: boolean;
}) {
  const terminalSessions = new Map<WebSocket, () => void>();
  const sseKeepalive = setInterval(() => {
    for (const client of sseClients) if (!client.writableEnded) client.write(": keepalive\n\n");
  }, 25_000);
  sseKeepalive.unref();

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
  });
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload: terminalFrameLimit });
  const remoteWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const initialVisibility = new WeakMap<WebSocket, ProjectVisibility>();
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
    let passwordVerified = false;
    const remote = pathname === REMOTE_TERMINAL_SOCKET && Boolean(openRemoteTerminal);
    try {
      await cluster?.verify(req, true);
      if (idaasAuth) idaasSession = await idaasAuth.authenticate(req);
      else passwordVerified = await passwordAuth.isAuthorized(req);
      if (passwordVerified && !sharedWorkspaceAllowed(req)) {
        status = 403;
        passwordVerified = false;
      }
      if (
        remote &&
        (!passwordVerified ||
          !req.headers.origin ||
          !matchesRequestOrigin({
            hostHeader: req.headers.host,
            origin: req.headers.origin,
            fetchSite: req.headers["sec-fetch-site"],
          }))
      ) {
        status = passwordVerified ? 403 : status;
        passwordVerified = false;
        idaasSession = null;
      }
      verified = true;
    } catch (error) {
      status = errorStatus(error, 503);
    }
    if (
      !verified ||
      (pathname !== "/ws" && pathname !== "/terminal" && !remote) ||
      (idaasAuth ? !idaasSession : !passwordVerified)
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
    const target = remote ? remoteWss : pathname === "/terminal" ? terminalWss : wss;
    target.handleUpgrade(req, socket, head, (client) => {
      const buffered: { data: RawData; binary: boolean }[] = [];
      let bufferedBytes = 0;
      const pendingMessage = (data: RawData, binary: boolean) => {
        bufferedBytes += Array.isArray(data) ? data.reduce((n, p) => n + p.byteLength, 0) : data.byteLength;
        if (buffered.length >= 64 || bufferedBytes > 1024 * 1024) {
          client.terminate();
          return;
        }
        buffered.push({ data, binary });
      };
      client.on("message", pendingMessage);
      void (async () => {
        if (idaasAuth && idaasSession) {
          const unwatch = idaasAuth.watch(idaasSession.id, () => client.terminate());
          client.once("close", unwatch);
        }
        if (!idaasAuth) {
          const unwatch = await passwordAuth.watch(req, () => client.terminate());
          if (client.readyState !== WebSocket.OPEN) {
            unwatch();
            return;
          }
          client.once("close", unwatch);
        }
        if (pathname === "/ws") initialVisibility.set(client, await projectVisibility.snapshot());
        if (client.readyState !== WebSocket.OPEN) return;
        client.off("message", pendingMessage);
        target.emit("connection", client, req);
        for (const message of buffered) {
          if (client.readyState !== WebSocket.OPEN) break;
          client.emit("message", message.data, message.binary);
        }
      })()
        .catch(() => client.terminate())
        .finally(() => {
          client.off("message", pendingMessage);
          buffered.length = 0;
        });
    });
  });
  remoteWss.on("connection", (client, req) => {
    client.on("error", () => client.terminate());
    void Promise.resolve()
      .then(() => openRemoteTerminal?.(client, req, new URL(req.url!, "http://localhost")))
      .catch(() => client.close(1008));
  });
  wss.on("connection", (client) => {
    browserWire.register(client, client.protocol === "panda-engine-v1");
    clients.add(client);
    client.send(JSON.stringify({ type: "projects/visibility", ...initialVisibility.get(client)! }));
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
    try {
      if (!terminalSocket && !allowLocalTerminal) {
        client.close(1011, "Terminal unavailable");
        return;
      }
      const url = new URL(req.url || "/terminal", "http://localhost");
      const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), browseRoots, defaultCwd);
      const stop = terminalSocket ? openTerminalRelay(client, terminalSocket, cwd) : openLocalTerminal(client, cwd);
      terminalSessions.set(client, stop);
      client.once("close", () => terminalSessions.delete(client));
    } catch (error) {
      console.error("[panda-force] terminal failed", error);
      client.close(1011, "Terminal unavailable");
      return;
    }
  });

  return {
    close() {
      clearInterval(sseKeepalive);
      for (const client of clients) client.terminate();
      clients.clear();
      for (const client of sseClients) client.end();
      sseClients.clear();
      wss.close();
      for (const [client, stop] of terminalSessions) {
        stop();
        client.terminate();
      }
      terminalSessions.clear();
      terminalWss.close();
      for (const client of remoteWss.clients) client.terminate();
      remoteWss.close();
    },
  };
}
