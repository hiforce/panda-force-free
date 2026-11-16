import type { Translate } from "../../shared/i18n/messages.js";
import { validAdministratorPassword } from "../../shared/password-policy.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, localizeText } from "../i18n.js";
import { requireElement } from "../dom.js";
import { usersRequest } from "./api.js";
import { createPasswordRecovery } from "./recovery.js";
import { pandaInterfaceMark } from "../panda-brand.js";

let disposeOnboarding: (() => void) | undefined;

const field = (label: string, name: string, type: string) =>
  `<div class="auth-field"><label for="onboarding-${name}">${e(label)}</label><input id="onboarding-${name}" name="${name}" type="${type}" required maxlength="${type === "password" ? 256 : 254}" autocomplete="${type === "password" ? "new-password" : "username"}"></div>`;

/** Tokens stay in tab memory and POST bodies. Merely opening an email never consumes its capability. */
export async function showEmailOnboarding(t: Translate, kind: "invite" | "verify-email" | "reset-password" | "forgot") {
  disposeOnboarding?.();
  document
    .querySelectorAll(
      "[data-email-onboarding],[data-email-onboarding-status],[data-email-onboarding-back],[data-email-onboarding-decoration]",
    )
    .forEach((element) => element.remove());
  const gate = requireElement("#passwordGate"),
    base = requireElement("#passwordLoginForm");
  gate.hidden = false;
  gate.dataset.emailFlow = kind;
  const clearPresentation = () => {
    delete gate.dataset.emailFlow;
    delete gate.dataset.emailComplete;
  };
  disposeOnboarding = clearPresentation;
  setMessageHtml(requireElement("#passwordCodexMark"), pandaInterfaceMark("password-panda-mark"));
  requireElement("#startupScreen").hidden = true;
  requireElement("#app").hidden = true;
  base.hidden = true;
  document.querySelector("[data-forgot-password]")?.remove();
  localizeText(
    requireElement("#passwordTitle"),
    kind === "verify-email" ? "users.verifyEmail" : kind === "invite" ? "users.setPassword" : "users.resetTitle",
    undefined,
    t,
  );
  localizeText(requireElement("#passwordDescription"), "users.mailExpiry", undefined, t);
  localizeText(requireElement("#passwordStep"), "common.pandaforce", undefined, t);
  const form = document.createElement("form");
  form.className = "password-login";
  form.setAttribute("data-email-onboarding", kind);
  base.after(form);
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("data-email-onboarding-status", "");
  form.after(status);
  const back = document.createElement("a");
  back.href = "/";
  back.className = "auth-email-back";
  localizeText(back, "users.backToLogin", undefined, t);
  back.setAttribute("data-email-onboarding-back", "");
  status.after(back);
  const error = (value: unknown) => {
    status.textContent = value instanceof Error ? value.message : t("users.unavailable");
  };
  if (kind === "forgot") {
    const success = document.createElement("span");
    success.className = "auth-email-success";
    success.hidden = true;
    success.setAttribute("aria-hidden", "true");
    success.setAttribute("data-email-onboarding-decoration", "");
    setMessageHtml(success, '<svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-8"/></svg>');
    requireElement("#passwordTitle").before(success);
    const disposeRecovery = createPasswordRecovery(
      t,
      form,
      status,
      requireElement("#passwordTitle"),
      requireElement("#passwordDescription"),
      (complete) => {
        gate.dataset.emailComplete = String(complete);
        back.hidden = complete;
        success.hidden = !complete;
      },
    );
    disposeOnboarding = () => {
      disposeRecovery();
      clearPresentation();
    };
    return;
  } else {
    try {
      const area = kind === "verify-email" ? "email" : kind === "reset-password" ? "reset" : "invitation";
      const result = await usersRequest<{ email: string }>(t, `/api/local-users/${area}/inspect`, "POST", { token });
      setMessageHtml(
        form,
        `<p data-i18n-ignore>${e(result.email)}</p>` +
          (kind === "verify-email"
            ? ""
            : field(t("common.newPassword"), "password", "password") +
              field(t("common.confirmPassword"), "confirm", "password") +
              `<p class="auth-field-hint">${e(t("users.passwordPolicy"))}</p>`) +
          `<button type="submit">${e(t(kind === "verify-email" ? "users.verifyEmail" : "users.setPassword"))}</button>`,
      );
    } catch (value) {
      error(value);
      return;
    }
  }
  let busy = false;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(form),
      button = form.querySelector<HTMLButtonElement>("button")!;
    status.textContent = "";
    try {
      if (kind !== "verify-email") {
        if (!validAdministratorPassword(String(values.get("password")))) throw new Error(t("users.passwordPolicy"));
        if (values.get("password") !== values.get("confirm")) throw new Error(t("auth.passwordsDoNotMatch"));
      }
      busy = true;
      button.disabled = true;
      form.setAttribute("aria-busy", "true");
      if (kind === "verify-email") await usersRequest(t, "/api/local-users/email/confirm", "POST", { token });
      else
        await usersRequest(t, `/api/local-users/${kind === "invite" ? "invitation" : "reset"}/accept`, "POST", {
          token,
          password: values.get("password"),
        });
      status.textContent = t(
        kind === "verify-email" ? "users.emailVerified" : kind === "invite" ? "users.activated" : "users.resetDone",
      );
      form.replaceChildren();
    } catch (value) {
      error(value);
    } finally {
      busy = false;
      button.disabled = false;
      form.removeAttribute("aria-busy");
    }
  };
  form.querySelector<HTMLInputElement>("input")?.focus();
}
