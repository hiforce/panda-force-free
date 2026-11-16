import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPPORTED_LOCALES } from "../../shared/i18n/locale-policy.js";
import { createApplicationDatabaseRegistry } from "./application-registry.js";
import { applicationMySQLRuntimeBindings } from "./runtime-stores.js";
import { DatabaseManagementState, type StoredDatabaseOperation } from "./management/state.js";
import { DatabaseManagementService } from "./management/service.js";
import { databaseManagementRoutes } from "./management/routes.js";
import { respondJson } from "../http/respond.js";
import { initializeDatabaseHostRecovery } from "./management/host-recovery.js";

/** This server has no business stores, engine connection, provider credentials or worker constructors. */
export async function startDatabaseMaintenance(options: {
  state: DatabaseManagementState;
  operationId: string;
  host: string;
  port: number;
  publicDir: string;
  wake: () => void;
}) {
  const { state, operationId } = options;
  const current = await state.read<StoredDatabaseOperation>("operations", operationId);
  if (!current) throw Error("operationNotFound");
  const service = new DatabaseManagementService({
    state,
    registry: createApplicationDatabaseRegistry,
    runtimeBindings: () => new Set(applicationMySQLRuntimeBindings),
    current: () => current.public.source,
    initialChoiceRequired: false,
    tableCount: () => 0,
    requestRestart: options.wake,
    resumeAfterCancel: options.wake,
  });
  const routes = databaseManagementRoutes({ service, owner: () => "", administrator: () => false });
  const hostRecovery = await initializeDatabaseHostRecovery({ state, operationId });
  const styles = [
      "/style.css",
      "/workbench.css",
      "/workbench-forms.css",
      "/workbench-layout.css",
      "/appearance.css",
      "/database.css",
    ],
    script = "/database-maintenance.bundle.js";
  const paths = [
    ...styles,
    script,
    "/i18n.js",
    "/http-client.js",
    ...SUPPORTED_LOCALES.map((l) => `/locales/${l.code}.json`),
  ];
  const assets = new Map<string, { body: Buffer; hash: string; type: string }>();
  for (const path of paths) {
    const body = await readFile(join(options.publicDir, path.slice(1)));
    assets.set(path, {
      body,
      hash: createHash("sha256").update(body).digest("hex"),
      type: path.endsWith(".css") ? "text/css" : path.endsWith(".json") ? "application/json" : "text/javascript",
    });
  }
  const versioned = (path: string) => path + "?v=" + assets.get(path)!.hash;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>PandaForce</title>${styles.map((path) => `<link rel="stylesheet" href="${versioned(path)}">`).join("")}<script type="module" src="${versioned(script)}"></script></head><body><div id="database-maintenance"></div></body></html>`;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost"),
        record = await state.read<StoredDatabaseOperation>("operations", operationId);
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      if (
        ["/health/liveness", "/health/startup"].includes(url.pathname) &&
        ["GET", "HEAD"].includes(req.method ?? "")
      ) {
        respondJson(res, 200, { ok: true, maintenance: true });
        return;
      }
      if (url.pathname === "/api/system/database/maintenance" && req.method === "GET") {
        respondJson(res, 200, {
          operationId,
          status:
            record?.public.status === "failed"
              ? "failed"
              : record?.public.status === "complete" || record?.public.status === "canceled"
                ? "complete"
                : "running",
        });
        return;
      }
      if (await hostRecovery.handle({ req, res, url })) return;
      if (await routes.handleCapability({ req, res, url }, operationId)) return;
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/health/")) {
        res.setHeader("retry-after", "2");
        respondJson(res, 503, { error: { code: "databaseUnavailable" } });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        return;
      }
      const asset = assets.get(url.pathname);
      if (asset) {
        res.writeHead(200, { "content-type": asset.type + "; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : asset.body);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html" || /^\/settings(?:\/[^/]+)?\/?$/.test(url.pathname)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : html);
        return;
      }
      res.writeHead(404);
      res.end();
    })().catch(() => {
      if (!res.headersSent) respondJson(res, 503, { error: { code: "databaseUnavailable" } });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    service,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
