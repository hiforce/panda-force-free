import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ADMINISTRATOR_PASSWORD_ERROR, validAdministratorPassword } from "../../shared/password-policy.js";
import { config } from "../config.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import type { AuthState } from "./state.js";
import {
  createStoredAdministrator,
  normalizeAdministratorUsername,
  saveStoredAdministrator,
  validAdministratorUsername,
} from "./administrator-store.js";
import {
  createPasswordSession,
  isAuthorizedHttpRequest,
  passwordSessionCookie,
  verifyStoredPassword,
} from "./security.js";

function sendAuthError(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) {
  respondJson(res, status, { error }, headers);
}

function trustedRequest(req: IncomingMessage) {
  if (!req.headers.host || req.headers["sec-fetch-site"] === "cross-site") return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return (
      ["http:", "https:"].includes(origin.protocol) &&
      origin.origin === req.headers.origin &&
      origin.host.toLowerCase() === req.headers.host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function equal(left: unknown, right: string) {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Local administrator installation, legacy migration and browser sessions. */
export function createPasswordAuth({ authState }: { authState: AuthState }) {
  const code = randomBytes(18).toString("base64url");
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const passwordSetupRequired = () => config.authMode !== "none" && !authState.secret;
  const migrationRequired = () => config.authMode !== "none" && Boolean(authState.secret) && !authState.administrator;
  const codeRequired = (req: IncomingMessage) => !isAuthorizedHttpRequest(req, null, true);
  const secureCookie = (req: IncomingMessage) =>
    Boolean((req.socket as any).encrypted) || req.headers.origin?.startsWith("https://") === true;
  const refresh = () => authState.refreshAdministrator();

  function isAuthorized(req: IncomingMessage) {
    refresh();
    if (isAuthorizedHttpRequest(req, authState.secret, config.authMode === "none")) return true;
    // Explicit service credentials remain valid for existing automation, but an
    // old browser cookie must not bypass the newly installed administrator.
    return Boolean(
      req.headers.authorization &&
      [config.accessToken, config.environmentPassword].some(
        (secret) => secret && isAuthorizedHttpRequest(req, secret, false),
      ),
    );
  }

  function issueSession(req: IncomingMessage, res: ServerResponse) {
    if (!authState.secret) throw new Error("Authentication is not configured");
    attempts.delete(req.socket.remoteAddress || "unknown");
    const session = createPasswordSession(authState.secret);
    respondJson(
      res,
      200,
      { ok: true, migrationRequired: migrationRequired() },
      {
        "set-cookie": passwordSessionCookie(session.token, { secure: secureCookie(req) }),
      },
    );
  }

  function rateLimited(req: IncomingMessage) {
    const key = req.socket.remoteAddress || "unknown",
      now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.expiresAt <= now) {
      for (const [address, value] of attempts) if (value.expiresAt <= now) attempts.delete(address);
      if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value!);
      entry = { count: 0, expiresAt: now + 300_000 };
      attempts.set(key, entry);
    }
    return ++entry.count > 20;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!["/api/auth/status", "/api/auth/setup", "/api/auth/login", "/api/auth/logout"].includes(url.pathname))
      return false;
    refresh();
    if (url.pathname === "/api/auth/status") {
      if (req.method !== "GET") {
        sendAuthError(res, 405, "Method not allowed", { allow: "GET" });
        return true;
      }
      const authenticated = isAuthorized(req);
      respondJson(res, 200, {
        authMode: "local",
        authenticated,
        setupRequired: passwordSetupRequired(),
        migrationRequired: migrationRequired(),
        usernameRequired: Boolean(authState.administrator),
        installationCodeRequired: passwordSetupRequired() && codeRequired(req),
        passwordRequired: authState.browserPasswordConfigured(),
        ...(authenticated && authState.administrator
          ? { identity: { username: authState.administrator.username, role: "admin" } }
          : {}),
      });
      return true;
    }
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return true;
    }
    if (!trustedRequest(req)) {
      sendAuthError(res, 403, "Authentication request was rejected");
      return true;
    }
    if (url.pathname === "/api/auth/logout") {
      if (!isAuthorized(req)) {
        sendAuthError(res, 401, "Authentication required");
        return true;
      }
      respondJson(
        res,
        200,
        { ok: true },
        { "set-cookie": passwordSessionCookie("", { secure: secureCookie(req), maxAgeSeconds: 0 }) },
      );
      return true;
    }
    if (rateLimited(req)) {
      sendAuthError(res, 429, "Too many attempts. Please try again in a few minutes.", { "retry-after": "300" });
      return true;
    }
    let payload: any;
    try {
      payload = await readJsonBody(req, 4096);
    } catch {
      sendAuthError(res, 400, "Invalid authentication request");
      return true;
    }
    const password = typeof payload?.password === "string" ? payload.password : "";
    const username = normalizeAdministratorUsername(payload?.username);
    if (url.pathname === "/api/auth/setup") {
      const fresh = passwordSetupRequired();
      if (authState.administrator || (!fresh && !migrationRequired()) || authState.setupInProgress) {
        sendAuthError(res, 409, "Administrator setup is no longer available");
        return true;
      }
      if (!validAdministratorUsername(username)) {
        sendAuthError(res, 400, "Use 3–64 letters, numbers, dots, underscores, @ or hyphens for the username.");
        return true;
      }
      if (fresh && !validAdministratorPassword(password)) {
        sendAuthError(res, 400, ADMINISTRATOR_PASSWORD_ERROR);
        return true;
      }
      if (fresh && codeRequired(req) && !equal(payload?.installationCode, code)) {
        sendAuthError(res, 403, "The installation code is incorrect. Check the server startup log.");
        return true;
      }
      if (!fresh && !isAuthorized(req)) {
        sendAuthError(res, 401, "Verify your existing password before creating the administrator account.");
        return true;
      }
      authState.setupInProgress = true;
      try {
        const credential = fresh ? password : authState.legacyCredential();
        if (!credential) throw new Error("Existing password credential is unavailable");
        const administrator = createStoredAdministrator(username, credential);
        saveStoredAdministrator(authState.administratorPath, administrator);
        authState.adoptAdministrator(administrator);
        issueSession(req, res);
      } catch (error: any) {
        if (error?.code === "EEXIST") {
          refresh();
          sendAuthError(res, 409, "Administrator setup is no longer available");
        } else {
          console.error("[codex-webui] administrator setup failed", error);
          sendAuthError(res, 500, "Unable to save the administrator account");
        }
      } finally {
        authState.setupInProgress = false;
      }
      return true;
    }
    let valid = false;
    if (password.length > 0 && password.length <= 256) {
      if (authState.administrator) {
        const passwordMatches = verifyStoredPassword(password, authState.administrator.password);
        valid = equal(username, authState.administrator.username) && passwordMatches;
      } else if (config.environmentPassword || config.accessToken)
        valid = equal(password, config.environmentPassword || config.accessToken!);
      else if (authState.managedPassword) valid = verifyStoredPassword(password, authState.managedPassword);
    }
    if (!valid) {
      sendAuthError(res, 401, authState.administrator ? "Incorrect username or password" : "Incorrect password");
      return true;
    }
    issueSession(req, res);
    return true;
  }

  return {
    handle,
    isAuthorized,
    passwordSetupRequired,
    installationCode: () => (passwordSetupRequired() ? code : null),
  };
}
