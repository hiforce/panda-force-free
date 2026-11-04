import { sessionLoginUrl } from "../shared/auth-return-path.js";

export function installWebuiSession(status, { translate: t = (message) => message, i18n } = {}) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  let checking = null,
    navigating = false,
    timer = null,
    notice = null,
    condition = "authenticated",
    lastCheck = -Infinity;

  function render() {
    if (condition === "authenticated") {
      if (notice) notice.hidden = true;
      return;
    }
    if (!notice) {
      notice = document.createElement("aside");
      notice.id = "webuiSessionNotice";
      notice.className = "webui-session-notice";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      const message = document.createElement("span"),
        button = document.createElement("button");
      message.className = "webui-session-message";
      button.type = "button";
      button.onclick = () => {
        if (condition !== "expired") {
          void check({ force: true });
          return;
        }
        if (navigating) return;
        dispatchEvent(new Event("codex-webui:before-login"));
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
    notice.querySelector("span").textContent = t(
      expired
        ? "Your sign-in has expired. Your page and draft are kept here. Sign in again to continue."
        : "Sign-in verification is temporarily unavailable. Retrying in the background.",
    );
    notice.querySelector("button").textContent = t(expired ? "Sign in again" : "Retry");
  }

  function setCondition(value) {
    // A network error cannot turn confirmed expiry back into an uncertain state.
    if (condition === "expired" && value === "unavailable") return;
    condition = value;
    render();
  }

  function check({ force = false } = {}) {
    if (navigating) return Promise.resolve();
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 5000) return Promise.resolve();
    lastCheck = Date.now();
    checking = originalFetch("/api/auth/status", {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Sign-in verification unavailable");
        const current = await response.json();
        if (current.authMode !== status.authMode || typeof current.authenticated !== "boolean")
          throw new Error("Invalid sign-in status");
        setCondition(current.authenticated ? "authenticated" : "expired");
        return current;
      })
      .catch(() => setCondition("unavailable"))
      .finally(() => {
        checking = null;
      });
    return checking;
  }

  globalThis.__codexWebuiCheckAuth = check;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.status === 401) {
      const input = args[0];
      const url = new URL(response.url || input?.url || String(input), location.href);
      if (url.origin === location.origin) void check();
    }
    return response;
  };
  const start = () => {
    if (timer === null) timer = setInterval(() => void check({ force: true }), 30000);
  };
  start();
  addEventListener("pagehide", () => {
    clearInterval(timer);
    timer = null;
  });
  addEventListener("pageshow", (event) => {
    if (event.persisted) {
      start();
      void check({ force: true });
    }
  });
  addEventListener("online", () => void check({ force: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  i18n?.subscribe(render);

  const button = document.createElement("button");
  button.type = "button";
  button.id = "webuiLogout";
  button.className = "account-menu-row";
  button.textContent = `${t("Log out")} (PandaForce · ${status.identity?.username || status.identity?.account || "PandaForce"})`;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const response = await originalFetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Unable to sign out");
      dispatchEvent(new Event("codex-webui:logged-out"));
      navigating = true;
      location.assign(status.authMode === "idaas" ? "/auth/logged-out" : "/");
    } catch {
      button.disabled = false;
    }
  };
  document.querySelector('[data-settings-content="general-settings"]')?.append(button);
}
