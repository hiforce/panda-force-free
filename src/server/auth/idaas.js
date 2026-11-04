import { randomBytes, createHash } from "node:crypto";
import { parseCookieHeader } from "./security.js";
import { authPageLanguage, sendAuthPage } from "./pages.js";
import { safeAuthReturnPath } from "../../shared/auth-return-path.js";

const SESSION_COOKIE = "codex_webui_idaas_session";
const STATE_COOKIE = "codex_webui_idaas_state";
const MAX_ITEMS = 2048;
const CACHE_MS = 30_000;
const STATE_MS = 300_000;
const SESSION_MS = 7_200_000;
const randomId = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const list = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readIdaasConfig(env = process.env) {
  const mode = env.CODEX_WEBUI_AUTH_MODE;
  if (mode && !["idaas", "password", "none"].includes(mode)) throw new Error("Invalid CODEX_WEBUI_AUTH_MODE");
  if (mode !== "idaas") {
    if (Object.keys(env).some((key) => key.startsWith("IDAAS_") && env[key])) {
      throw new Error("Set CODEX_WEBUI_AUTH_MODE=idaas when configuring IDAAS");
    }
    return null;
  }
  for (const key of [
    "IDAAS_AUTH_ENDPOINT",
    "IDAAS_BROWSER_ENDPOINT",
    "IDAAS_CLIENT_ID",
    "IDAAS_CLIENT_SECRET",
    "CODEX_WEBUI_PUBLIC_URL",
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
  const publicUrl = new URL(endpoint(env.CODEX_WEBUI_PUBLIC_URL, true));
  if (publicUrl.pathname !== "/") throw new Error("CODEX_WEBUI_PUBLIC_URL must use the domain root");
  return {
    endpoint: endpoint(env.IDAAS_AUTH_ENDPOINT),
    browserEndpoint: endpoint(env.IDAAS_BROWSER_ENDPOINT, true),
    publicUrl: publicUrl.origin,
    callbackUrl: `${publicUrl.origin}/auth/callback`,
    clientId: env.IDAAS_CLIENT_ID.trim(),
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
      console.info("[codex-webui] auth/session-closed", JSON.stringify(session.identity));
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
  const sameOrigin = (req) => {
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    if (req.headers.host !== new URL(config.publicUrl).host) return false;
    if (!req.headers.origin) return true;
    try {
      return new URL(req.headers.origin).origin === config.publicUrl;
    } catch {
      return false;
    }
  };
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
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
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
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("Invalid response");
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
      return payload.data ?? payload;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, "IDAAS is unavailable; try again later");
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
      if (error.status === 401) drop(id);
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
          console.warn("[codex-webui] auth/verification-unavailable");
        }
      });
    }
  }, 5000);
  timer.unref();

  async function handle(req, res, url) {
    if (
      ![
        "/auth/login",
        "/auth/relogin",
        "/auth/callback",
        "/auth/logged-out",
        "/api/auth/status",
        "/api/auth/logout",
        "/api/auth/login",
        "/api/auth/setup",
      ].includes(url.pathname)
    )
      return false;
    try {
      if (url.pathname === "/auth/relogin") {
        if (req.method !== "POST") throw new AuthError(405, "Method not allowed");
        if (!sameOrigin(req)) throw new AuthError(403, "Cross-origin request rejected");
        rateLimit(req);
        const id = sessionId(req);
        if (id) drop(id);
        const binding = parseCookieHeader(req.headers.cookie)[STATE_COOKIE];
        if (binding) {
          const hash = digest(binding);
          for (const [state, transaction] of transactions) if (transaction.binding === hash) transactions.delete(state);
        }
        // IDAAS /logout clears its browser SSO cookies even when the denied
        // identity never received a WebUI session or a locally stored id_token.
        // Its redirectUri parameter is camelCase; /oidc/auth uses redirect_uri.
        const target = new URL(`${config.browserEndpoint}/logout`);
        target.searchParams.set("redirectUri", `${config.publicUrl}/auth/login`);
        redirect(res, target.href, [cookie(SESSION_COOKIE, "", 0), cookie(STATE_COOKIE, "", 0)]);
        return true;
      }
      if (url.pathname === "/auth/logged-out") {
        if (req.method !== "GET") throw new AuthError(405, "Method not allowed");
        sendAuthPage(res, { kind: "signedOut", status: 200, language: authPageLanguage(req) });
        return true;
      }
      if (["/api/auth/login", "/api/auth/setup"].includes(url.pathname))
        throw new AuthError(404, "Password login is disabled");
      if (url.pathname === "/auth/login") {
        if (req.method !== "GET") throw new AuthError(405, "Method not allowed");
        // Top-level links may start login cross-site; the callback is browser-bound by state.
        if (
          req.headers.host !== new URL(config.publicUrl).host ||
          (req.headers.origin && req.headers.origin !== config.publicUrl)
        )
          throw new AuthError(403, "Cross-origin request rejected");
        rateLimit(req);
        makeRoom(transactions);
        const state = randomId();
        const binding = randomId();
        const nonce = randomId();
        transactions.set(state, {
          binding: digest(binding),
          expiresAt: now() + STATE_MS,
          nonce,
          returnTo: safeAuthReturnPath(url.searchParams.get("returnTo")),
        });
        const target = new URL(`${config.browserEndpoint}/oidc/auth`);
        for (const [key, value] of Object.entries({
          client_id: config.clientId,
          redirect_uri: config.callbackUrl,
          protocol: "oidc",
          scope: "user",
          response_type: "code",
          response_mode: "query",
          state,
          nonce,
        }))
          target.searchParams.set(key, value);
        redirect(res, target.href, [cookie(STATE_COOKIE, binding, 300)]);
        return true;
      }
      if (url.pathname === "/auth/callback") {
        if (req.method !== "GET" || req.headers.host !== new URL(config.publicUrl).host)
          throw new AuthError(400, "Invalid login callback");
        rateLimit(req);
        const states = url.searchParams.getAll("state");
        const codes = url.searchParams.getAll("code");
        const transaction = states.length === 1 ? transactions.get(states[0]) : null;
        const binding = parseCookieHeader(req.headers.cookie)[STATE_COOKIE];
        if (!transaction || transaction.expiresAt <= now() || !binding || digest(binding) !== transaction.binding)
          throw new AuthError(400, "Invalid or expired login state");
        transactions.delete(states[0]);
        if (url.searchParams.has("error") || codes.length !== 1 || !codes[0] || codes[0].length > 4096)
          throw new AuthError(400, "Login was not completed");
        const tokens = await upstream("/oidc/token", {
          grant_type: "authorization_code",
          code: codes[0],
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.callbackUrl,
        });
        if (
          typeof tokens.access_token !== "string" ||
          !tokens.access_token ||
          tokens.access_token.length > 32768 ||
          !Number.isFinite(tokens.expires_in) ||
          tokens.expires_in <= 0
        )
          throw new AuthError(401, "Invalid IDAAS token response");
        const claims = await validateToken(tokens.access_token);
        const user = await upstream("/oidc/me", {}, tokens.access_token);
        if (
          typeof user.uuid !== "string" ||
          !user.uuid ||
          typeof user.account !== "string" ||
          !user.account ||
          user.tenantId == null
        )
          throw new AuthError(401, "Incomplete IDAAS identity");
        if (!config.tenants.has(String(user.tenantId)) || !config.accounts.has(user.account))
          throw new AuthError(403, "This account is not allowed to use PandaForce");
        makeRoom(sessions);
        const previous = sessionId(req);
        if (previous) drop(previous);
        const id = randomId();
        const expiresAt = Math.min(now() + SESSION_MS, now() + tokens.expires_in * 1000, claims.exp * 1000);
        if (expiresAt <= now()) throw new AuthError(401, "Your login has expired");
        sessions.set(id, {
          identity: { uuid: user.uuid, account: user.account, tenantId: String(user.tenantId) },
          accessToken: tokens.access_token,
          idToken: typeof tokens.id_token === "string" ? tokens.id_token : null,
          expiresAt,
          connections: new Set(),
        });
        console.info("[codex-webui] auth/login", JSON.stringify(sessions.get(id).identity));
        redirect(res, transaction.returnTo, [
          cookie(SESSION_COOKIE, id, Math.max(1, Math.floor((expiresAt - now()) / 1000))),
          cookie(STATE_COOKIE, "", 0),
        ]);
        return true;
      }
      if (url.pathname === "/api/auth/status") {
        if (req.method !== "GET") throw new AuthError(405, "Method not allowed");
        let session = null;
        try {
          session = await authenticate(req);
        } catch (error) {
          if (error.status !== 401) throw error;
        }
        json(res, 200, {
          authMode: "idaas",
          authenticated: Boolean(session),
          passwordRequired: false,
          setupRequired: false,
          loginUrl: "/auth/login",
          ...(session ? { identity: session.identity, expiresAt: session.expiresAt } : {}),
        });
        return true;
      }
      if (url.pathname === "/api/auth/logout") {
        if (req.method !== "POST") throw new AuthError(405, "Method not allowed");
        if (!sameOrigin(req)) throw new AuthError(403, "Cross-origin request rejected");
        const id = sessionId(req);
        const session = sessions.get(id);
        if (id) drop(id);
        let logoutUrl = "/auth/logged-out";
        if (url.searchParams.get("global") === "true" && session?.idToken) {
          const target = new URL(`${config.browserEndpoint}/oidc/logout`);
          target.searchParams.set("id_token", session.idToken);
          target.searchParams.set("redirect_uri", `${config.publicUrl}/auth/logged-out`);
          logoutUrl = target.href;
        }
        json(res, 200, { ok: true, logoutUrl }, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
        return true;
      }
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 503;
      // Browser navigation receives a readable page. API/fetch clients keep the
      // JSON contract, even when they explicitly request HTML.
      if (
        (req.method === "GET" || (req.method === "POST" && url.pathname === "/auth/relogin")) &&
        url.pathname.startsWith("/auth/") &&
        (req.headers["sec-fetch-dest"] === "document" || String(req.headers.accept || "").includes("text/html"))
      ) {
        const kind =
          error instanceof AuthError && error.message === "This account is not allowed to use PandaForce"
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
        error: error instanceof AuthError ? error.message : "Authentication unavailable",
        loginUrl: "/auth/login",
      });
    }
    return true;
  }
  return {
    handle,
    authenticate,
    sameOrigin,
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
