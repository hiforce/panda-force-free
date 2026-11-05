import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { readRequestBytes } from "../request-bytes.js";
import { respondJson } from "../http/respond.js";
import { errorStatus } from "../../shared/errors.js";
import type { CoordinationStore, OwnerLease } from "./contracts.js";
import { ClusterError } from "./contracts.js";
import type { ClusterConfig } from "./config.js";
import { readClusterConfig } from "./config.js";
import { createPostgresCoordination } from "./postgres.js";
import { CLUSTER_HEADER, signClusterRequest } from "./signing.js";

const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function publicHeaders(request: IncomingMessage, config: ClusterConfig, upgrade = false): IncomingHttpHeaders {
  const connection = String(request.headers.connection || "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(
      ([name]) => !hop.has(name) && !connection.includes(name) && !name.startsWith(CLUSTER_HEADER),
    ),
  );
  headers.host = new URL(config.publicUrl).host;
  headers["x-forwarded-for"] = request.socket.remoteAddress || "unknown";
  headers["x-forwarded-proto"] = new URL(config.publicUrl).protocol.slice(0, -1);
  delete headers.forwarded;
  delete headers["x-real-ip"];
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}
const transport = (url: URL) => (url.protocol === "https:" ? httpsRequest : httpRequest);
function target(lease: OwnerLease, path: string) {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new ClusterError("Invalid proxy path", "cluster_request_rejected", 400);
  const url = new URL(lease.address);
  // Assign the opaque request target, never let it replace the registered owner host.
  const query = path.indexOf("?");
  url.pathname = query < 0 ? path : path.slice(0, query);
  url.search = query < 0 ? "" : path.slice(query);
  return url;
}
/** A gateway owns HTTP sockets only. Authentication and native work stay with the fenced owner. */
export async function createClusterGateway(
  config: ClusterConfig,
  { store = createPostgresCoordination(config.databaseUrl) }: { store?: CoordinationStore } = {},
) {
  if (config.role !== "gateway") throw new Error("Expected gateway role");
  await store.initialize();
  const sockets = new Set<Socket>();
  let closing = false;
  async function owner() {
    if (closing) throw new ClusterError("Gateway is shutting down");
    const lease = await store.currentOwner(config.workspace);
    if (!lease) throw new ClusterError("Workspace owner is temporarily unavailable", "cluster_owner_unavailable");
    return lease;
  }
  function headersFor(
    request: IncomingMessage,
    lease: OwnerLease,
    path: string,
    method: string,
    body: Buffer,
    upgrade = false,
  ) {
    const headers = publicHeaders(request, config, upgrade);
    if (!upgrade) headers["content-length"] = String(body.length);
    return { ...headers, ...signClusterRequest(config, lease, { method, path, headers }, body) };
  }
  async function authorizeLargeWrite(request: IncomingMessage, lease: OwnerLease) {
    const path = "/api/health",
      body = Buffer.alloc(0),
      url = target(lease, path);
    await new Promise<void>((resolve, reject) => {
      const upstream = transport(url)(
        url,
        { method: "GET", headers: headersFor(request, lease, path, "GET", body), timeout: 10_000 },
        (response) => {
          response.resume();
          if ((response.statusCode || 503) >= 400)
            reject(
              new ClusterError(
                "Authentication or workspace verification failed",
                "cluster_preflight_rejected",
                response.statusCode || 503,
              ),
            );
          else resolve();
        },
      );
      upstream.once("error", () =>
        reject(new ClusterError("Workspace owner is unavailable", "cluster_owner_unavailable")),
      );
      upstream.once("timeout", () => upstream.destroy(new Error("Owner verification timed out")));
      upstream.end();
    });
  }
  const server = createServer(async (request, response) => {
    try {
      const path = request.url || "/",
        method = request.method || "GET";
      if (
        ["/health/startup", "/health/liveness", "/health/readiness"].includes(path) &&
        ["GET", "HEAD"].includes(method)
      ) {
        const ready = path !== "/health/readiness" || Boolean(await store.currentOwner(config.workspace));
        respondJson(response, ready && !closing ? 200 : 503, { ok: ready && !closing });
        return;
      }
      const lease = await owner();
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && path.startsWith("/api/") && !path.startsWith("/api/auth/"))
        await authorizeLargeWrite(request, lease);
      const body = await readRequestBytes(
        request,
        path.startsWith("/auth/") || path.startsWith("/api/auth/") ? 256_000 : 128 * 1024 * 1024,
      );
      const url = target(lease, path);
      await new Promise<void>((resolve, reject) => {
        const upstream = transport(url)(
          url,
          {
            method,
            headers: headersFor(request, lease, url.pathname + url.search, method, body),
            timeout: url.pathname === "/api/events" ? 0 : config.requestTimeoutMs,
          },
          (result) => {
            const headers = Object.fromEntries(Object.entries(result.headers).filter(([name]) => !hop.has(name)));
            response.writeHead(result.statusCode || 502, headers);
            result.pipe(response);
            result.once("end", resolve);
            result.once("error", reject);
          },
        );
        upstream.once("error", reject);
        upstream.once("timeout", () => upstream.destroy(new Error("Workspace response timed out")));
        response.once("close", () => upstream.destroy());
        upstream.end(body);
      });
    } catch (error) {
      if (response.headersSent) response.destroy();
      else
        respondJson(response, errorStatus(error, 503), {
          error: error instanceof ClusterError ? error.message : "Workspace request could not be completed",
          code: error instanceof ClusterError ? error.code : "cluster_delivery_uncertain",
        });
    }
  });
  server.keepAliveTimeout = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", async (request, client: Duplex, head: Buffer) => {
    try {
      const path = request.url || "/";
      if (!["/ws", "/terminal"].includes(new URL(path, "http://localhost").pathname))
        throw new ClusterError("Unsupported socket path", "cluster_request_rejected", 404);
      const lease = await owner(),
        url = target(lease, path);
      const upstream = transport(url)(url, {
        method: "GET",
        headers: headersFor(request, lease, url.pathname + url.search, "GET", Buffer.alloc(0), true),
        timeout: 10_000,
      });
      const reject = () => {
        if (!client.destroyed)
          client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      };
      upstream.once("error", reject);
      upstream.once("timeout", () => upstream.destroy(new Error("Socket owner unavailable")));
      upstream.once("response", (response) => {
        const body = "Authentication or workspace verification failed";
        client.end(
          `HTTP/1.1 ${response.statusCode || 503} Rejected\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        response.resume();
      });
      upstream.once("upgrade", (response, socket, ownerHead) => {
        upstream.setTimeout(0);
        client.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            Object.entries(response.headers)
              .map(([name, value]) => name + ": " + value)
              .join("\r\n") +
            "\r\n\r\n",
        );
        if (ownerHead.length) client.write(ownerHead);
        if (head.length) socket.write(head);
        client.pipe(socket).pipe(client);
        socket.once("error", () => client.destroy());
        client.once("error", () => socket.destroy());
        client.once("close", () => socket.destroy());
        socket.once("close", () => client.destroy());
      });
      client.once("close", () => upstream.destroy());
      upstream.end();
    } catch {
      client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  return {
    server,
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}
if (import.meta.main) {
  const config = readClusterConfig();
  if (!config || config.role !== "gateway") throw new Error("Gateway entry requires PANDA_FORCE_CLUSTER_ROLE=gateway");
  const gateway = await createClusterGateway(config);
  gateway.server.listen(Number(process.env.PORT || 8899), process.env.HOST || "127.0.0.1", () =>
    console.info("[PandaForce] Cluster gateway is listening"),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void gateway.close().then(() => process.exit(0));
    });
}
