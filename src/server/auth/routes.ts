import { dirname, join } from "node:path";
import { createSessionRevocations } from "./session-revocations.js";
import type { PasswordAuth } from "./contracts.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validAdministratorPassword } from "../../shared/password-policy.js";
import { config } from "../config.js";
import { readJsonBody } from "../http/body.js";
import { respondJson } from "../http/respond.js";
import { errorPayload } from "../i18n/error-payload.js";
import { errorCode } from "./../../shared/errors.js";
import {
  createStoredAdministrator,
  normalizeAdministratorUsername,
  saveStoredAdministrator,
  validAdministratorUsername,
} from "./administrator-store.js";
import { matchesRequestOrigin } from "./origin.js";
import {
  createPasswordSession,
  isAuthorizedHttpRequest,
  passwordSessionCookie,
  passwordSessionToken,
  verifyStoredPassword,
} from "./security.js";
import type { AuthState } from "./state.js";

function sendAuthError(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}) {
  respondJson(res, status, errorPayload(error), headers);
}

function trustedRequest(req: IncomingMessage) {
  return matchesRequestOrigin({
    hostHeader: req.headers.host,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
  });
}

function equal(left: unknown, right: string) {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Local administrator installation, legacy migration and browser sessions. */
export function createPasswordAuth({ authState }: { authState: AuthState }): PasswordAuth {
  const revocations = createSessionRevocations(
    join(dirname(dirname(authState.administratorPath)), "data", "auth-sessions.sqlite"),
  );
  const code = randomBytes(18).toString("base64url");
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const passwordSetupRequired = () => config.authMode !== "none" && !authState.secret;
  const migrationRequired = () => config.authMode !== "none" && Boolean(authState.secret) && !authState.administrator;
  const codeRequired = (req: IncomingMessage) => !isAuthorizedHttpRequest(req, null, true);
  const secureCookie = (req: IncomingMessage) =>
    Boolean((req.socket as import("node:tls").TLSSocket).encrypted) ||
    req.headers.origin?.startsWith("https://") === true;
  const refresh = () => authState.refreshAdministrator();

  function isAuthorized(req: IncomingMessage) {
    refresh();
    const token = passwordSessionToken(req);
    if (!req.headers.authorization && token && revocations.has(token)) return false;
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
        sendAuthError(res, 405, "errors.methodNotAllowed", { allow: "GET" });
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
      sendAuthError(res, 405, "errors.methodNotAllowed", { allow: "POST" });
      return true;
    }
    if (!trustedRequest(req)) {
      sendAuthError(res, 403, "auth.requestRejected");
      return true;
    }
    if (url.pathname === "/api/auth/logout") {
      if (!isAuthorized(req)) {
        sendAuthError(res, 401, "auth.authenticationRequired");
        return true;
      }
      await readJsonBody(req, 4096);
      const token = passwordSessionToken(req);
      if (token) revocations.revoke(token);
      respondJson(
        res,
        200,
        { ok: true },
        { "set-cookie": passwordSessionCookie("", { secure: secureCookie(req), maxAgeSeconds: 0 }) },
      );
      return true;
    }
    if (rateLimited(req)) {
      sendAuthError(res, 429, "auth.tooManyAttempts", { "retry-after": "300" });
      return true;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await readJsonBody(req, 4096);
    } catch {
      sendAuthError(res, 400, "auth.invalidRequest");
      return true;
    }
    const password = typeof payload?.password === "string" ? payload.password : "";
    const username = normalizeAdministratorUsername(payload?.username);
    if (url.pathname === "/api/auth/setup") {
      const fresh = passwordSetupRequired();
      if (authState.administrator || (!fresh && !migrationRequired()) || authState.setupInProgress) {
        sendAuthError(res, 409, "auth.setupUnavailable");
        return true;
      }
      if (!validAdministratorUsername(username)) {
        sendAuthError(res, 400, "auth.usernamePolicy");
        return true;
      }
      if (fresh && !validAdministratorPassword(password)) {
        sendAuthError(res, 400, "auth.passwordPolicy");
        return true;
      }
      if (fresh && codeRequired(req) && !equal(payload?.installationCode, code)) {
        sendAuthError(res, 403, "auth.installationCodeIncorrect");
        return true;
      }
      if (!fresh && !isAuthorized(req)) {
        sendAuthError(res, 401, "auth.existingPasswordRequired");
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
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          refresh();
          sendAuthError(res, 409, "auth.setupUnavailable");
        } else {
          console.error("[panda-force] administrator setup failed", error);
          sendAuthError(res, 500, "auth.saveAdministratorFailed");
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
      sendAuthError(res, 401, authState.administrator ? "auth.incorrectCredentials" : "auth.incorrectPassword");
      return true;
    }
    issueSession(req, res);
    return true;
  }

  return {
    watch(req, onRevoke) {
      const token = passwordSessionToken(req);
      return !req.headers.authorization && token ? revocations.watch(token, onRevoke) : () => {};
    },
    close: revocations.close,
    handle,
    isAuthorized,
    passwordSetupRequired,
    installationCode: () => (passwordSetupRequired() ? code : null),
  };
}
