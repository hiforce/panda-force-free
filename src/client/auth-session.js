import { findElement } from "./dom.js";
import { observeAuthentication } from "./http-client.js";
import { getBrowserI18n, localizeText } from "./i18n.js";
import { createLifecycle } from "./lifecycle.js";
const sessions = new WeakMap();

import { sessionLoginUrl } from "../shared/auth-return-path.js";

const CHECK_INTERVAL_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 20_000;
const NOTICE_DELAY_MS = 15_000;

/** @param {{authMode: string; identity?: {username?: string; account?: string}}} status @param {{translate?: import("../shared/i18n/messages.js").Translate; i18n?: ReturnType<typeof getBrowserI18n>}} options */
export function installPandaForceSession(status, { translate: t = getBrowserI18n().t, i18n = undefined } = {}) {
  if (sessions.has(document)) return sessions.get(document);
  const lifecycle = createLifecycle();
  const originalFetch = globalThis.fetch.bind(globalThis);
  let checking = null,
    navigating = false,
    timer = null,
    notice = null,
    condition = "authenticated",
    lastCheck = -Infinity,
    lastVerifiedAt = Date.now(),
    failures = 0,
    firstFailureAt = null,
    controller = null,
    suspended = false;

  const paused = () => suspended || document.visibilityState === "hidden" || navigator.onLine === false;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (paused() || navigating || condition === "expired") return;
    const delay = failures
      ? Math.min(2000 * 2 ** Math.min(failures - 1, 5), 60_000)
      : Math.max(1000, CHECK_INTERVAL_MS - (Date.now() - lastVerifiedAt));
    timer = setTimeout(() => void check({ force: true }), delay);
  };
  const pause = () => {
    clearTimer();
    controller?.abort("session-check-paused");
    failures = 0;
    firstFailureAt = null;
  };

  function render() {
    if (condition === "authenticated") {
      if (notice) notice.hidden = true;
      return;
    }
    if (!notice) {
      notice = document.createElement("aside");
      notice.id = "pandaSessionNotice";
      notice.className = "panda-session-notice";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      const message = document.createElement("span"),
        button = document.createElement("button");
      message.className = "panda-session-message";
      button.type = "button";
      button.onclick = () => {
        if (condition !== "expired") {
          void check({ force: true });
          return;
        }
        if (navigating) return;
        dispatchEvent(new Event("panda-force:before-login"));
        navigating = true;
        const current = location.pathname + location.search + location.hash;
        location.assign(status.authMode === "idaas" ? sessionLoginUrl(current) : current);
      };
      notice.append(message, button);
      document.body.append(notice);
    }
    const expired = condition === "expired";
    notice.hidden = false;
    notice.dataset.status = condition;
    localizeText(
      findElement("span", notice),
      expired
        ? "common.yourSignInHasExpiredYourPageAndDraftAre"
        : "common.signInVerificationIsTemporarilyUnavailableRetryingInTheBackground",
      undefined,
      t,
    );
    localizeText(findElement("button", notice), expired ? "common.signInAgain" : "common.retry", undefined, t);
  }

  function setCondition(value) {
    // A network error cannot turn confirmed expiry back into an uncertain state.
    if (condition === "expired" && value === "unavailable") return;
    condition = value;
    render();
  }

  function check({ force = false } = {}) {
    if (navigating || paused()) return Promise.resolve();
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 5000) return Promise.resolve();
    lastCheck = Date.now();
    clearTimer();
    const requestController = new AbortController();
    controller = requestController;
    const timeout = setTimeout(() => requestController.abort("session-check-timeout"), CHECK_TIMEOUT_MS);
    checking = originalFetch("/api/auth/status", {
      cache: "no-store",
      redirect: "error",
      signal: requestController.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Sign-in verification unavailable");
        const current = await response.json();
        if (current.authMode !== status.authMode || typeof current.authenticated !== "boolean")
          throw new Error("Invalid sign-in status");
        failures = 0;
        firstFailureAt = null;
        lastVerifiedAt = Date.now();
        setCondition(current.authenticated ? "authenticated" : "expired");
        return current;
      })
      .catch(() => {
        if (paused() || requestController.signal.reason === "session-check-paused") return;
        failures++;
        firstFailureAt ??= Date.now();
        // Only the notice is delayed; protected requests still require server authentication.
        if (failures >= 3 && Date.now() - firstFailureAt >= NOTICE_DELAY_MS) setCondition("unavailable");
      })
      .finally(() => {
        clearTimeout(timeout);
        controller = null;
        checking = null;
        schedule();
      });
    return checking;
  }

  const unobserve = observeAuthentication(check);
  const resume = () => {
    schedule();
    if (Date.now() - lastVerifiedAt >= 60_000) void check({ force: true });
  };
  schedule();
  lifecycle.on(globalThis, "pagehide", () => {
    suspended = true;
    pause();
  });
  lifecycle.on(globalThis, "pageshow", (event) => {
    if (event.persisted) {
      suspended = false;
      resume();
    }
  });
  lifecycle.on(globalThis, "online", resume);
  lifecycle.on(globalThis, "offline", pause);
  lifecycle.on(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") resume();
    else pause();
  });
  const unsubscribeLocale = i18n?.subscribe(render);

  const button = document.createElement("button");
  button.type = "button";
  button.id = "pandaLogout";
  button.className = "account-menu-row";
  localizeText(
    button,
    "common.logoutIdentity",
    { account: status.identity?.username || status.identity?.account || "PandaForce" },
    t,
  );
  button.onclick = async () => {
    button.disabled = true;
    try {
      const response = await originalFetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Unable to sign out");
      const pendingCleanup = [];
      dispatchEvent(
        new CustomEvent("panda-force:logged-out", {
          detail: { waitUntil: (promise) => pendingCleanup.push(promise) },
        }),
      );
      await Promise.allSettled(pendingCleanup);
      navigating = true;
      location.assign(status.authMode === "idaas" ? "/auth/logged-out" : "/");
    } catch {
      button.disabled = false;
    }
  };
  findElement('[data-settings-content="general-settings"]')?.append(button);
  const handle = {
    check,
    dispose() {
      suspended = true;
      pause();
      lifecycle.dispose();
      unobserve();
      unsubscribeLocale?.();
      notice?.remove();
      button.remove();
      sessions.delete(document);
    },
  };
  sessions.set(document, handle);
  if (globalThis.__pandaForceTest) globalThis.__pandaForceCheckAuth = check;
  return handle;
}
