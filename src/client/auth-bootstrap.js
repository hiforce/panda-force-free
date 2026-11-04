import { applyThemePreference } from "./theme.js";
import { installWebuiSession } from "./auth-session.js";
import { sessionLoginUrl } from "../shared/auth-return-path.js";
import { codexInterfaceMark } from "./codex-brand.js";
import { createDomI18n, createI18n } from "./i18n.js";
import { startStartupReads } from "./startup-reads.js";
import { getWorkspacePreparation } from "./workspace-preparation.js";
import {
  ADMINISTRATOR_PASSWORD_ERROR,
  MIN_ADMINISTRATOR_PASSWORD_LENGTH,
  validAdministratorPassword,
} from "../shared/password-policy.js";

applyThemePreference();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyThemePreference());

const $ = (selector) => document.querySelector(selector);
const i18n = globalThis.__codexWebuiI18n || createI18n();
globalThis.__codexWebuiI18n = i18n;
globalThis.__codexWebuiDomI18n = globalThis.__codexWebuiDomI18n || createDomI18n(i18n);
const t = (message) => i18n.t(message);

function showAuthFailure(message) {
  $("#passwordGate").hidden = false;
  $("#app").hidden = true;
  $("#passwordStep").textContent = t("Connection unavailable");
  $("#passwordTitle").textContent = t("Please try again");
  $("#passwordDescription").textContent = message;
  $("#passwordLoginForm").hidden = true;
  const retry = $("#authRetryButton");
  retry.hidden = false;
  retry.onclick = () => location.reload();
}

async function loadApp() {
  const preparation = getWorkspacePreparation();
  preparation.begin();
  startStartupReads();
  for (const href of ["/vendor/katex/katex.min.css", "/vendor/xterm/xterm.css"]) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }
  $("#app").hidden = false;
  try {
    await import("/app.bundle.js");
    preparation.complete("interface");
    return true;
  } catch (error) {
    preparation.fail("interface");
    console.error("[panda-force] workspace interface could not be loaded", error);
    return false;
  }
}

async function readStatus() {
  const response = await fetch("/api/auth/status", { cache: "no-store" });
  if (!response.ok) throw new Error(t("Authentication is temporarily unavailable. Please retry."));
  return response.json();
}

async function start() {
  let status;
  try {
    status = await readStatus();
  } catch (error) {
    showAuthFailure(error.message);
    return;
  }
  const finish = async () => {
    globalThis.__pandaForceIdentity = status.identity || {};
    const identity =
      status.authMode +
      ":" +
      (status.identity?.uuid || status.identity?.username || status.identity?.account || "local");
    globalThis.__pandaForceIdentityKey = identity;
    try {
      const previous = localStorage.getItem("panda-force-browser-identity");
      if ((previous && previous !== identity) || (!previous && status.authMode === "idaas")) {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("codex-webui-") && key !== "codex-webui-locale") localStorage.removeItem(key);
      }
      localStorage.setItem("panda-force-browser-identity", identity);
    } catch {}

    $("#passwordGate").hidden = true;
    if (!(await loadApp())) return;
    if (status.authMode === "idaas" || status.passwordRequired) installWebuiSession(status, { translate: t, i18n });
  };
  if (status.authMode === "idaas") {
    if (!status.authenticated) {
      location.assign(sessionLoginUrl(location.pathname + location.search + location.hash));
      return;
    }
    await finish();
    return;
  }
  if (status.authenticated && !status.migrationRequired) {
    await finish();
    return;
  }

  const gate = $("#passwordGate"),
    input = $("#passwordInput"),
    confirm = $("#passwordConfirmInput"),
    username = $("#usernameInput"),
    code = $("#installationCodeInput"),
    button = $("#passwordLoginButton"),
    error = $("#passwordError"),
    visibility = $("#passwordVisibility");
  let mode;
  $("#passwordCodexMark").innerHTML = codexInterfaceMark("password-codex-mark");
  const action = () =>
    mode === "setup" ? "Create administrator" : mode === "migrate" ? "Save and continue" : "Log in";
  const field = (id, element, visible) => {
    $(id).hidden = !visible;
    element.disabled = !visible;
    element.required = visible;
  };
  const configure = () => {
    mode = status.setupRequired ? "setup" : status.authenticated && status.migrationRequired ? "migrate" : "login";
    const setup = mode === "setup",
      migrate = mode === "migrate",
      needsUsername = setup || migrate || status.usernameRequired;
    $("#passwordStep").textContent = t(setup ? "First-time setup" : migrate ? "One last step" : "Your workspace");
    $("#passwordTitle").textContent = t(
      setup ? "Create your administrator" : migrate ? "Complete your administrator account" : "Welcome back",
    );
    $("#passwordDescription").textContent = t(
      setup
        ? "Set up your account to make this workspace yours."
        : migrate
          ? "Your existing password is verified. Choose a username to finish setup."
          : status.migrationRequired
            ? "Sign in with your existing password to complete administrator setup."
            : "Sign in to continue to your workspace.",
    );
    gate.setAttribute(
      "aria-label",
      t(setup ? "Administrator setup" : migrate ? "Complete administrator setup" : "PandaForce login"),
    );
    field("#usernameField", username, needsUsername);
    if ((setup || migrate) && !username.value) username.value = "admin";
    $("#usernameLabel").textContent = t(setup || migrate ? "Administrator username" : "Username");
    field("#passwordField", input, !migrate);
    field("#passwordConfirmField", confirm, setup);
    confirm.hidden = !setup;
    field("#installationCodeField", code, setup && status.installationCodeRequired);
    $("#passwordHint").hidden = !setup;
    input.placeholder = t(setup ? "New password" : "Password");
    input.autocomplete = setup ? "new-password" : "current-password";
    input.minLength = setup ? MIN_ADMINISTRATOR_PASSWORD_LENGTH : 0;
    input.type = "password";
    visibility.setAttribute("aria-pressed", "false");
    visibility.setAttribute("aria-label", t("Show password"));
    button.textContent = t(action());
    requestAnimationFrame(() =>
      (setup && status.installationCodeRequired ? code : needsUsername ? username : input).focus(),
    );
  };
  visibility.onclick = () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    visibility.setAttribute("aria-pressed", String(show));
    visibility.setAttribute("aria-label", t(show ? "Hide password" : "Show password"));
  };
  gate.hidden = false;
  configure();
  $("#passwordLoginForm").onsubmit = async (event) => {
    event.preventDefault();
    error.hidden = true;
    const submittingMode = mode;
    try {
      if ((mode !== "login" || status.usernameRequired) && !/^[a-z0-9][a-z0-9._@-]{2,63}$/i.test(username.value.trim()))
        throw new Error(t("Use 3–64 letters, numbers, dots, underscores, @ or hyphens for the username."));
      if (mode === "setup" && !validAdministratorPassword(input.value))
        throw new Error(t(ADMINISTRATOR_PASSWORD_ERROR));
      if (mode === "setup" && input.value !== confirm.value) throw new Error(t("Passwords do not match"));
      button.disabled = true;
      button.textContent = t(
        mode === "setup" ? "Creating administrator…" : mode === "migrate" ? "Saving…" : "Logging in…",
      );
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: username.value,
          password: mode === "migrate" ? undefined : input.value,
          installationCode: mode === "setup" ? code.value : undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) {
          status = await readStatus();
          input.value = "";
          confirm.value = "";
          configure();
          throw new Error(t("An administrator account already exists. Log in to continue."));
        }
        throw new Error(t(data.error || "Unable to log in"));
      }
      input.value = "";
      confirm.value = "";
      code.value = "";
      status = await readStatus();
      if (status.migrationRequired) {
        configure();
        return;
      }
      await finish();
    } catch (reason) {
      gate.hidden = false;
      $("#app").hidden = true;
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      error.hidden = false;
      if (submittingMode === "login" && !input.disabled) input.select();
    } finally {
      button.disabled = false;
      button.textContent = t(action());
    }
  };
}

start().catch((error) => {
  console.error("[codex-webui] authentication bootstrap failed", error);
  showAuthFailure(t("Could not open the workspace. Please reload."));
});
