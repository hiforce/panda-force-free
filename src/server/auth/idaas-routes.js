import { safeAuthReturnPath } from "../../shared/auth-return-path.js";
import { errorStatus } from "./../../shared/errors.js";
import { AuthError } from "./idaas-error.js";
import { authPageLanguage, sendAuthPage } from "./pages.js";
import { parseCookieHeader } from "./security.js";
/** Route handlers receive explicit session, transaction and upstream services. */
export function createIdaasRoutes({
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
}) {
  async function route0(req, res, url) {
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
    const target = new URL(`${config.browserEndpoint}/logout`);
    target.searchParams.set("redirectUri", `${config.publicUrl}/auth/login`);
    redirect(res, target.href, [cookie(SESSION_COOKIE, "", 0), cookie(STATE_COOKIE, "", 0)]);
    return true;
  }

  async function route1(req, res, url) {
    if (req.method !== "GET") throw new AuthError(405, "Method not allowed");
    sendAuthPage(res, { kind: "signedOut", status: 200, language: authPageLanguage(req) });
    return true;
  }

  async function route2(req, res, url) {
    throw new AuthError(404, "Password login is disabled");
  }

  async function route3(req, res, url) {
    if (req.method !== "GET") throw new AuthError(405, "Method not allowed");
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

  async function route4(req, res, url) {
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
    console.info("[panda-force] auth/login", JSON.stringify(sessions.get(id).identity));
    redirect(res, transaction.returnTo, [
      cookie(SESSION_COOKIE, id, Math.max(1, Math.floor((expiresAt - now()) / 1000))),
      cookie(STATE_COOKIE, "", 0),
    ]);
    return true;
  }

  async function route5(req, res, url) {
    if (req.method !== "GET") throw new AuthError(405, "Method not allowed");
    let session = null;
    try {
      session = await authenticate(req);
    } catch (error) {
      if (errorStatus(error) !== 401) throw error;
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

  async function route6(req, res, url) {
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

  return {
    "/auth/relogin": route0,
    "/auth/logged-out": route1,
    "/api/auth/login": route2,
    "/api/auth/setup": route2,
    "/auth/login": route3,
    "/auth/callback": route4,
    "/api/auth/status": route5,
    "/api/auth/logout": route6,
  };
}
