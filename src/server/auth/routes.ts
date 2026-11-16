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
import { matchesCookieMutationOrigin, matchesRequestOrigin } from "./origin.js";
import {
  createPasswordSession,
  isAuthorizedHttpRequest,
  passwordSessionCookie,
  passwordSessionToken,
  verifyStoredPassword,
} from "./security.js";
import type { AuthState } from "./state.js";
import type { SessionRevocations } from "./session-ports.js";
import type { LocalAccounts } from "./users/service.js";
import { localAdministratorIdentity } from "./users/service.js";
import { localRequestIdentity, recordLocalIdentity } from "./users/identity.js";

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
export function createPasswordAuth({
  authState,
  revocations: providedRevocations,
  accounts,
}: {
  authState: AuthState;
  revocations?: SessionRevocations;
  accounts?: LocalAccounts | null;
}): PasswordAuth {
  const revocations =
    providedRevocations ??
    createSessionRevocations(authState.revocationsPath, Date.now, authState.legacyRevocationsPath);
  const code = randomBytes(18).toString("base64url");
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  const passwordSetupRequired = () => config.authMode !== "none" && !authState.secret;
  const migrationRequired = () => config.authMode !== "none" && Boolean(authState.secret) && !authState.administrator;
  const codeRequired = (req: IncomingMessage) => !isAuthorizedHttpRequest(req, null, true);
  const secureCookie = (req: IncomingMessage) =>
    Boolean((req.socket as import("node:tls").TLSSocket).encrypted) ||
    req.headers.origin?.startsWith("https://") === true;
  const refresh = async () => {
    await authState.refreshAdministrator();
    const replacement = await accounts?.administratorPassword();
    if (replacement && authState.administrator)
      authState.adoptAdministrator({ ...authState.administrator, password: replacement });
  };
  const rootWatchers = new Map<() => void, string | null>();
  let rootTimer: ReturnType<typeof setInterval> | undefined,
    rootPolling = false;
  const watchRoot = (close: () => void) => {
    rootWatchers.set(close, authState.secret);
    if (!rootTimer) {
      rootTimer = setInterval(() => {
        if (rootPolling) return;
        rootPolling = true;
        void refresh()
          .then(
            () => {
              for (const [callback, secret] of rootWatchers)
                if (secret !== authState.secret) {
                  rootWatchers.delete(callback);
                  callback();
                }
            },
            () => {
              for (const callback of rootWatchers.keys()) callback();
              rootWatchers.clear();
            },
          )
          .finally(() => {
            rootPolling = false;
          });
      }, 1000);
      rootTimer.unref();
    }
    return () => {
      rootWatchers.delete(close);
      if (!rootWatchers.size && rootTimer) {
        clearInterval(rootTimer);
        rootTimer = undefined;
      }
    };
  };
  const explicitCredential = (req: IncomingMessage) =>
    Boolean(
      req.headers.authorization &&
      [authState.secret, config.accessToken, authState.administrator ? null : config.environmentPassword].some(
        (secret) => secret && isAuthorizedHttpRequest(req, secret, false, false),
      ),
    );

  async function isAuthorized(req: IncomingMessage) {
    recordLocalIdentity(req, null);
    await refresh();
    // Service credentials are independent of browser cookies; an unrelated
    // Authorization header must never change cookie revocation semantics.
    if (explicitCredential(req)) {
      recordLocalIdentity(req, localAdministratorIdentity(authState));
      return true;
    }
    const token = passwordSessionToken(req);
    if (token && (!trustedRequest(req) || !matchesCookieMutationOrigin(req))) return false;
    if (token && (await revocations.has(token))) return false;
    const user = await accounts?.authenticate(token);
    if (user) {
      recordLocalIdentity(req, user);
      return true;
    }
    const authorized = isAuthorizedHttpRequest(req, authState.secret, config.authMode === "none");
    if (authorized) recordLocalIdentity(req, localAdministratorIdentity(authState));
    return authorized;
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
    await refresh();
    if (url.pathname === "/api/auth/status") {
      if (req.method !== "GET") {
        sendAuthError(res, 405, "errors.methodNotAllowed", { allow: "GET" });
        return true;
      }
      const authenticated = await isAuthorized(req);
      respondJson(res, 200, {
        authMode: "local",
        authenticated,
        setupRequired: passwordSetupRequired(),
        migrationRequired: migrationRequired(),
        usernameRequired: Boolean(authState.administrator),
        installationCodeRequired: passwordSetupRequired() && codeRequired(req),
        passwordRequired: authState.browserPasswordConfigured(),
        passwordResetAvailable: accounts ? await accounts.passwordResetAvailable() : false,
        ...(authenticated && localRequestIdentity(req)
          ? {
              identity: {
                id: localRequestIdentity(req)!.id,
                username: localRequestIdentity(req)!.username,
                role: localRequestIdentity(req)!.role,
              },
            }
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
      if (!(await isAuthorized(req))) {
        sendAuthError(res, 401, "auth.authenticationRequired");
        return true;
      }
      await readJsonBody(req, 4096);
      const token = passwordSessionToken(req);
      if (token) await revocations.revoke(token);
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
      if (!fresh && !(await isAuthorized(req))) {
        sendAuthError(res, 401, "auth.existingPasswordRequired");
        return true;
      }
      authState.setupInProgress = true;
      try {
        const credential = fresh ? password : authState.legacyCredential();
        if (!credential) throw new Error("Existing password credential is unavailable");
        const administrator = createStoredAdministrator(username, credential);
        if (authState.saveAdministrator) await authState.saveAdministrator(administrator);
        else saveStoredAdministrator(authState.administratorPath, administrator);
        authState.adoptAdministrator(administrator);
        issueSession(req, res);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          await refresh();
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
        valid =
          (equal(username, authState.administrator.username) ||
            Boolean(await accounts?.administratorLogin(username))) &&
          passwordMatches;
      } else if (config.environmentPassword || config.accessToken)
        valid = equal(password, config.environmentPassword || config.accessToken!);
      else if (authState.managedPassword) valid = verifyStoredPassword(password, authState.managedPassword);
    }
    if (!valid && accounts && username && password.length > 0 && password.length <= 256) {
      const session = await accounts.login(username, password);
      if (session) {
        attempts.delete(req.socket.remoteAddress || "unknown");
        respondJson(
          res,
          200,
          { ok: true, migrationRequired: false },
          {
            "set-cookie": passwordSessionCookie(session.token, { secure: secureCookie(req) }),
          },
        );
        return true;
      }
    }
    if (!valid) {
      sendAuthError(res, 401, authState.administrator ? "auth.incorrectCredentials" : "auth.incorrectPassword");
      return true;
    }
    issueSession(req, res);
    return true;
  }

  return {
    async watch(req, onRevoke) {
      const token = passwordSessionToken(req);
      if (!token || explicitCredential(req)) return () => {};
      const unwatchSession = await revocations.watch(token, onRevoke);
      const user = await accounts?.authenticate(token);
      const unwatchUser = user ? await accounts!.watch(user, onRevoke) : watchRoot(onRevoke);
      return () => {
        unwatchSession();
        unwatchUser();
      };
    },
    close: async () => {
      if (rootTimer) clearInterval(rootTimer);
      rootWatchers.clear();
      await revocations.close();
    },
    handle,
    isAuthorized,
    passwordSetupRequired,
    installationCode: () => (passwordSetupRequired() ? code : null),
  };
}
