import { createHash, randomBytes } from "node:crypto";
import { pandaEnvironment } from "../environment.js";
import { respondJson } from "../http/respond.js";
import { errorMessage, errorStatus } from "./../../shared/errors.js";
import { AuthError } from "./idaas-error.js";
import { createIdaasRoutes } from "./idaas-routes.js";
import { matchesRequestOrigin } from "./origin.js";
import { authPageLanguage, sendAuthPage } from "./pages.js";
import { parseCookieHeader } from "./security.js";
export { AuthError } from "./idaas-error.js";

const SESSION_COOKIE = "panda_force_idaas_session";
const STATE_COOKIE = "panda_force_idaas_state";
const MAX_ITEMS = 2048;
const CACHE_MS = 5 * 60_000;
const STATE_MS = 300_000;
const SESSION_MS = 7_200_000;
const randomId = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const list = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function readIdaasConfig(env = process.env) {
  env = pandaEnvironment(env);
  const mode = env.PANDA_FORCE_AUTH_MODE;
  if (mode && !["idaas", "password", "none"].includes(mode)) throw new Error("Invalid PANDA_FORCE_AUTH_MODE");
  if (mode !== "idaas") {
    if (Object.keys(env).some((key) => key.startsWith("IDAAS_") && env[key])) {
      throw new Error("Set PANDA_FORCE_AUTH_MODE=idaas when configuring IDAAS");
    }
    return null;
  }
  for (const key of [
    "IDAAS_AUTH_ENDPOINT",
    "IDAAS_BROWSER_ENDPOINT",
    "IDAAS_CLIENT_ID",
    "IDAAS_CLIENT_SECRET",
    "PANDA_FORCE_PUBLIC_URL",
    "IDAAS_ALLOWED_TENANT_IDS",
    "IDAAS_ALLOWED_ACCOUNTS",
  ]) {
    if (!env[key]?.trim()) throw new Error(`${key} is required in IDAAS mode`);
  }
  const endpoint = (value, publicEndpoint = false) => {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (publicEndpoint && url.protocol !== "https:" && !local)
    )
      throw new Error("Invalid IDAAS endpoint");
    return url.href.replace(/\/$/, "");
  };
  const publicUrl = new URL(endpoint(env.PANDA_FORCE_PUBLIC_URL, true));
  if (publicUrl.pathname !== "/") throw new Error("PANDA_FORCE_PUBLIC_URL must use the domain root");
  return {
    endpoint: endpoint(env.IDAAS_AUTH_ENDPOINT),
    browserEndpoint: endpoint(env.IDAAS_BROWSER_ENDPOINT, true),
    publicUrl: publicUrl.origin,
    callbackUrl: `${publicUrl.origin}/auth/callback`,
    clientId: String(env.IDAAS_CLIENT_ID).trim(),
    clientSecret: env.IDAAS_CLIENT_SECRET,
    tenants: new Set(list(env.IDAAS_ALLOWED_TENANT_IDS)),
    accounts: new Set(list(env.IDAAS_ALLOWED_ACCOUNTS)),
    secure: publicUrl.protocol === "https:",
  };
}

export function createIdaasAuth(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const sessions = new Map();
  const transactions = new Map();
  const cache = new Map();
  const inFlight = new Map();
  const rates = new Map();
  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? "; Secure" : ""}`;
  const sessionId = (req) => parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  const closeConnections = (session) => {
    const connections = [...session.connections];
    session.connections.clear();
    for (const close of connections) {
      try {
        close();
      } catch {
        /* Already closed. */
      }
    }
  };
  const drop = (id) => {
    const session = sessions.get(id);
    sessions.delete(id);
    if (session) {
      console.info("[panda-force] auth/session-closed", JSON.stringify(session.identity));
      closeConnections(session);
    }
  };
  const prune = () => {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) drop(id);
    for (const map of [transactions, cache, rates]) {
      for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    }
  };
  const makeRoom = (map) => {
    prune();
    if (map.size >= MAX_ITEMS) throw new AuthError(503, "Authentication capacity reached; try again later");
  };
  const sameOrigin = (req) =>
    matchesRequestOrigin({
      hostHeader: req.headers.host,
      origin: req.headers.origin,
      fetchSite: req.headers["sec-fetch-site"],
      expectedOrigin: config.publicUrl,
    });
  const rateLimit = (req) => {
    const key = req.socket.remoteAddress || "unknown";
    let rate = rates.get(key);
    if (!rate || rate.expiresAt <= now()) {
      makeRoom(rates);
      rate = { count: 0, expiresAt: now() + STATE_MS };
      rates.set(key, rate);
    }
    if (++rate.count > 60) throw new AuthError(429, "Too many login attempts; try again later");
  };
  const json = (res, status, body, headers = {}) =>
    respondJson(res, status, body, { "referrer-policy": "no-referrer", ...headers });
  const redirect = (res, location, cookies = []) => {
    res.writeHead(303, {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": cookies,
    });
    res.end();
  };
  async function upstream(path, body, token) {
    const started = performance.now();
    let httpStatus = null;
    let outcome = "unavailable";
    try {
      const response = await fetchImpl(`${config.endpoint}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      httpStatus = response.status;
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("Invalid response");
      if (!response.body) throw new AuthError(503, "IDAAS returned an empty response");
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 128 * 1024) {
            await reader.cancel();
            throw new Error("Response too large");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (payload?.success === false)
        throw path === "/oidc/token/introspection"
          ? new AuthError(503, "IDAAS is unavailable; try again later")
          : new AuthError(401, "IDAAS rejected the credentials");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid response");
      outcome = "ok";
      return payload.data ?? payload;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, "IDAAS is unavailable; try again later");
    } finally {
      const durationMs = Math.round(performance.now() - started);
      if (durationMs >= 1000 || outcome !== "ok")
        console.warn(
          "[panda-force] auth/provider-request",
          JSON.stringify({ operation: path, durationMs, httpStatus, outcome }),
        );
    }
  }
  async function validateToken(token) {
    const key = digest(token);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.claims;
    if (inFlight.has(key)) return inFlight.get(key);
    makeRoom(inFlight);
    const promise = (async () => {
      const claims = await upstream("/oidc/token/introspection", {
        token,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      if (
        claims.active === false ||
        (claims.active === true && Number.isFinite(claims.exp) && claims.exp * 1000 <= now())
      ) {
        cache.delete(key);
        throw new AuthError(401, "Your login has expired");
      }
      if (claims.active !== true || !Number.isFinite(claims.exp))
        throw new AuthError(503, "IDAAS is unavailable; try again later");
      if (cache.size >= MAX_ITEMS) cache.delete(cache.keys().next().value);
      cache.set(key, { claims, expiresAt: Math.min(now() + CACHE_MS, claims.exp * 1000) });
      return claims;
    })();
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }
  async function authenticate(req) {
    if (!sameOrigin(req)) throw new AuthError(403, "Cross-origin request rejected");
    const id = sessionId(req);
    const session = sessions.get(id);
    if (!session || session.expiresAt <= now()) {
      if (id) drop(id);
      throw new AuthError(401, "Authentication required");
    }
    try {
      await validateToken(session.accessToken);
    } catch (error) {
      if (errorStatus(error) === 401) drop(id);
      throw error;
    }
    // A concurrent logout or expiry must not revive an in-flight authorization.
    if (sessions.get(id) !== session || session.expiresAt <= now()) throw new AuthError(401, "Your login has expired");
    return { id, identity: session.identity, expiresAt: session.expiresAt };
  }
  const timer = setInterval(() => {
    prune();
    for (const [id, session] of sessions) {
      if (!session.connections.size) continue;
      validateToken(session.accessToken).catch((error) => {
        if (sessions.get(id) !== session) return;
        if (error.status === 401) drop(id);
        else {
          // Fail closed for live channels while retaining the bounded session:
          // an IDAAS outage is not evidence that the user signed out.
          closeConnections(session);
          console.warn("[panda-force] auth/verification-unavailable");
        }
      });
    }
  }, 5000);
  timer.unref();

  const routes = createIdaasRoutes({
    now,
    config,
    sessions,
    transactions,
    cookie,
    sessionId,
    drop,
    makeRoom,
    sameOrigin,
    rateLimit,
    json,
    redirect,
    upstream,
    validateToken,
    authenticate,
    SESSION_COOKIE,
    STATE_COOKIE,
    STATE_MS,
    SESSION_MS,
    randomId,
    digest,
  });
  async function handle(req, res, url) {
    const route = routes[url.pathname];
    if (!route) return false;
    const started = performance.now();
    try {
      await route(req, res, url);
    } catch (error) {
      const status = error instanceof AuthError ? errorStatus(error) : 503;
      // Browser navigation receives a readable page. API/fetch clients keep the
      // JSON contract, even when they explicitly request HTML.
      if (
        (req.method === "GET" || (req.method === "POST" && url.pathname === "/auth/relogin")) &&
        url.pathname.startsWith("/auth/") &&
        (req.headers["sec-fetch-dest"] === "document" || String(req.headers.accept || "").includes("text/html"))
      ) {
        const kind =
          error instanceof AuthError && errorMessage(error) === "This account is not allowed to use PandaForce"
            ? "denied"
            : status === 400 || status === 401
              ? "incomplete"
              : status === 403
                ? "rejected"
                : status === 429
                  ? "limited"
                  : "unavailable";
        sendAuthPage(res, {
          kind,
          status,
          language: authPageLanguage(req),
          idaasOrigin: new URL(config.browserEndpoint).origin,
        });
        return true;
      }
      json(res, status, {
        error: error instanceof AuthError ? errorMessage(error) : "Authentication unavailable",
        loginUrl: "/auth/login",
      });
    } finally {
      const durationMs = Math.round(performance.now() - started);
      if (url.pathname === "/api/auth/status" && (durationMs >= 1000 || res.statusCode >= 500))
        console.warn("[panda-force] auth/status-request", JSON.stringify({ durationMs, httpStatus: res.statusCode }));
    }
    return true;
  }
  return {
    handle,
    authenticate,
    watch(id, close) {
      const session = sessions.get(id);
      if (!session || session.expiresAt <= now()) {
        close();
        return () => {};
      }
      session.connections.add(close);
      const timeout = setTimeout(() => drop(id), Math.max(1, session.expiresAt - now()));
      timeout.unref();
      return () => {
        clearTimeout(timeout);
        session.connections.delete(close);
      };
    },
    close() {
      clearInterval(timer);
      for (const id of sessions.keys()) drop(id);
      transactions.clear();
      cache.clear();
    },
  };
}
