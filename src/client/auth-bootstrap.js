import {
  bindMessages,
  errorText,
  getBrowserI18n,
  localizeAttribute,
  localizeText,
  setMessageHtml,
  setOpaqueText,
} from "./i18n.js";

import { applyThemePreference } from "./theme.js";
import { installPandaForceSession } from "./auth-session.js";
import { sessionLoginUrl } from "../shared/auth-return-path.js";
import { pandaInterfaceMark } from "./panda-brand.js";

import { startStartupReads } from "./startup-reads.js";
import { getWorkspacePreparation } from "./workspace-preparation.js";
import { MIN_ADMINISTRATOR_PASSWORD_LENGTH, validAdministratorPassword } from "../shared/password-policy.js";

applyThemePreference();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyThemePreference());

const $ = (selector) => document.querySelector(selector);
const i18n = getBrowserI18n();

const t = i18n.t;

function showAuthFailure(message) {
  $("#passwordGate").hidden = false;
  $("#app").hidden = true;
  localizeText($("#passwordStep"), "auth.connectionUnavailable", undefined, t);
  localizeText($("#passwordTitle"), "auth.pleaseTryAgain", undefined, t);
  setOpaqueText($("#passwordDescription"), message);
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
  if (!response.ok) throw new Error(t("errors.authenticationIsTemporarilyUnavailablePleaseRetry"));
  return response.json();
}

async function start() {
  await i18n.ready;
  bindMessages(document);
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
          if (key.startsWith("panda-force-") && key !== "panda-force-locale") localStorage.removeItem(key);
      }
      localStorage.setItem("panda-force-browser-identity", identity);
    } catch {}

    $("#passwordGate").hidden = true;
    if (!(await loadApp())) return;
    if (status.authMode === "idaas" || status.passwordRequired)
      installPandaForceSession(status, { translate: t, i18n });
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
  setMessageHtml($("#passwordCodexMark"), pandaInterfaceMark("password-panda-mark"));
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
    localizeText(
      $("#passwordStep"),
      setup ? "common.firstTimeSetup" : migrate ? "common.oneLastStep" : "common.yourWorkspace",
      undefined,
      t,
    );
    localizeText(
      $("#passwordTitle"),
      setup
        ? "common.createYourAdministrator"
        : migrate
          ? "common.completeYourAdministratorAccount"
          : "common.welcomeBack",
      undefined,
      t,
    );
    localizeText(
      $("#passwordDescription"),
      setup
        ? "common.setUpYourAccountToMakeThisWorkspaceYours"
        : migrate
          ? "common.yourExistingPasswordIsVerifiedChooseAUsernameToFinish"
          : status.migrationRequired
            ? "common.signInWithYourExistingPasswordToCompleteAdministratorSetup"
            : "common.signInToContinueToYourWorkspace",
      undefined,
      t,
    );
    localizeAttribute(
      gate,
      "aria-label",
      setup ? "common.administratorSetup" : migrate ? "common.completeAdministratorSetup" : "common.pandaforceLogin",
      undefined,
      t,
    );
    field("#usernameField", username, needsUsername);
    if ((setup || migrate) && !username.value) username.value = "admin";
    localizeText(
      $("#usernameLabel"),
      setup || migrate ? "common.administratorUsername" : "common.username",
      undefined,
      t,
    );
    field("#passwordField", input, !migrate);
    field("#passwordConfirmField", confirm, setup);
    confirm.hidden = !setup;
    field("#installationCodeField", code, setup && status.installationCodeRequired);
    $("#passwordHint").hidden = !setup;
    localizeAttribute(input, "placeholder", setup ? "common.newPassword" : "common.password", undefined, t);
    input.autocomplete = setup ? "new-password" : "current-password";
    input.minLength = setup ? MIN_ADMINISTRATOR_PASSWORD_LENGTH : 0;
    input.type = "password";
    visibility.setAttribute("aria-pressed", "false");
    localizeAttribute(visibility, "aria-label", "common.showPassword", undefined, t);
    localizeText(button, action(), undefined, t);
    requestAnimationFrame(() =>
      (setup && status.installationCodeRequired ? code : needsUsername ? username : input).focus(),
    );
  };
  visibility.onclick = () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    visibility.setAttribute("aria-pressed", String(show));
    localizeAttribute(visibility, "aria-label", show ? "common.hidePassword" : "common.showPassword", undefined, t);
  };
  gate.hidden = false;
  configure();
  $("#passwordLoginForm").onsubmit = async (event) => {
    event.preventDefault();
    error.hidden = true;
    const submittingMode = mode;
    try {
      if ((mode !== "login" || status.usernameRequired) && !/^[a-z0-9][a-z0-9._@-]{2,63}$/i.test(username.value.trim()))
        throw new Error(t("auth.use364LettersNumbersDotsUnderscoresOrHyphensFor"));
      if (mode === "setup" && !validAdministratorPassword(input.value)) throw new Error(t("auth.passwordPolicy"));
      if (mode === "setup" && input.value !== confirm.value) throw new Error(t("auth.passwordsDoNotMatch"));
      button.disabled = true;
      localizeText(
        button,
        mode === "setup" ? "common.creatingAdministrator" : mode === "migrate" ? "goals.saving" : "common.loggingIn",
        undefined,
        t,
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
          throw new Error(t("auth.anAdministratorAccountAlreadyExistsLogInToContinue"));
        }
        throw new Error(errorText(data, t, "errors.unableToLogIn"));
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
      setOpaqueText(error, reason instanceof Error ? reason.message : String(reason));
      error.hidden = false;
      if (submittingMode === "login" && !input.disabled) input.select();
    } finally {
      button.disabled = false;
      localizeText(button, action(), undefined, t);
    }
  };
}

start().catch((error) => {
  console.error("[panda-force] authentication bootstrap failed", error);
  showAuthFailure(t("errors.couldNotOpenTheWorkspacePleaseReload"));
});
