import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { validAdministratorPassword } from "../../shared/password-policy.js";
import { getBrowserI18n, setMessageHtml, localizeText } from "../i18n.js";
import { usersRequest } from "./api.js";

const storageKey = "panda-force-password-recovery";
interface RecoveryDraft {
  identifier: string;
  challengeId: string;
  verificationId: string;
  resendAt: number;
  expiresAt: number;
  autoSend?: boolean;
}
/** Only a non-authenticating challenge reference is persisted; codes, grants and passwords stay in tab memory. */
export function beginPasswordRecovery(identifier = "", autoSend = false) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ identifier, autoSend, expiresAt: Date.now() + 600_000 }));
  } catch {}
  location.assign("/reset-password");
}

export function createPasswordRecovery(
  t: Translate,
  form: HTMLFormElement,
  status: HTMLElement,
  title: HTMLElement,
  description: HTMLElement,
  showComplete: (complete: boolean) => void,
) {
  form.before(status);
  let draft: RecoveryDraft = {
    identifier: "",
    challengeId: "",
    verificationId: crypto.randomUUID(),
    resendAt: 0,
    expiresAt: 0,
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (saved && typeof saved.identifier === "string" && saved.identifier.length <= 254 && saved.expiresAt > Date.now())
      draft = { ...draft, ...saved };
  } catch {}
  let phase: "identify" | "code" | "password" | "complete" = draft.challengeId ? "code" : "identify";
  let code = "",
    grant = "",
    password = "",
    confirm = "",
    busy = false,
    disposed = false,
    epoch = 0;
  let feedback: MessageId | null = draft.challengeId ? "users.codeRequested" : null,
    failure = "";
  const persist = () => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ ...draft, autoSend: false }));
    } catch {}
  };
  const path = (next: string, replace = false) => {
    if (location.pathname !== next) history[replace ? "replaceState" : "pushState"]({}, "", next);
  };
  const field = (label: string, name: string, value: string, type: string) =>
    `<div class="auth-field"><label for="recovery-${name}">${e(label)}</label><input id="recovery-${name}" name="${name}" type="${type}" required maxlength="${type === "password" ? 256 : 254}" autocomplete="${type === "password" ? "new-password" : "username"}" value="${e(value)}"></div>`;
  function notify() {
    status.className = "auth-recovery-notice";
    status.hidden = !feedback && !failure;
    status.dataset.state = failure ? "error" : busy ? "pending" : "success";
    status.setAttribute("role", failure ? "alert" : "status");
    const text = failure || (feedback ? t(feedback) : "");
    if (status.textContent !== text) status.textContent = text;
  }
  function controls() {
    form.setAttribute("aria-busy", String(busy));
    const remaining = Math.max(0, Math.ceil((draft.resendAt - Date.now()) / 1000));
    for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
    const resend = form.querySelector<HTMLButtonElement>("[data-recovery-resend]");
    if (resend) {
      resend.disabled = busy || remaining > 0;
      resend.textContent = remaining ? t("users.resendCountdown", { seconds: remaining }) : t("users.resendCode");
    }
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit)
      submit.textContent = t(
        busy
          ? phase === "identify" || feedback === "users.sendingCode"
            ? "users.sendingCode"
            : phase === "code"
              ? "users.checkingCode"
              : "users.savingPassword"
          : phase === "identify"
            ? "users.sendCode"
            : phase === "code"
              ? "users.verifyContinue"
              : "users.setPassword",
      );
    notify();
  }
  function paintCode() {
    const input = form.querySelector<HTMLInputElement>("#recovery-code");
    if (!input) return;
    const index = Math.min(5, input.selectionStart ?? code.length);
    for (const [i, cell] of [...form.querySelectorAll<HTMLElement>("[data-code-cell]")].entries()) {
      cell.textContent = code[i] ?? "";
      cell.dataset.active = String(i === index);
    }
    input.setAttribute("aria-invalid", String(Boolean(failure)));
  }
  function render() {
    showComplete(phase === "complete");
    epoch++;
    localizeText(
      title,
      phase === "code"
        ? "users.enterCodeTitle"
        : phase === "password"
          ? "users.choosePassword"
          : phase === "complete"
            ? "users.resetDoneTitle"
            : "users.resetTitle",
      undefined,
      t,
    );
    localizeText(
      description,
      phase === "identify"
        ? "users.recoveryIntro"
        : phase === "code"
          ? "users.codeInstructions"
          : phase === "password"
            ? "users.passwordPolicy"
            : "users.resetDone",
      undefined,
      t,
    );
    const progress =
      phase !== "complete"
        ? `<p class="auth-recovery-steps">${e(t(phase === "password" ? "users.recoveryStepTwo" : "users.recoveryStepOne"))}</p>`
        : "";
    const identity = draft.identifier
      ? `<p class="auth-recovery-identity" data-i18n-ignore>${e(draft.identifier)}</p>`
      : "";
    setMessageHtml(
      form,
      progress +
        (phase === "identify"
          ? field(t("users.usernameOrEmail"), "identifier", draft.identifier, "text") +
            `<button type="submit">${e(t("users.sendCode"))}</button>`
          : phase === "code"
            ? identity +
              `<div class="auth-field"><label for="recovery-code">${e(t("users.verificationCode"))}</label><div class="auth-code">${Array.from({ length: 6 }, (_, i) => `<span class="auth-code-cell" data-code-cell="${i}" aria-hidden="true"></span>`).join("")}<input class="auth-code-input" id="recovery-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required aria-describedby="recovery-code-hint" value="${e(code)}"></div><p id="recovery-code-hint" class="auth-field-hint">${e(t("users.codeExpiry"))}</p></div><button type="submit">${e(t("users.verifyContinue"))}</button><div class="auth-recovery-actions"><button type="button" data-recovery-back>${e(t("users.changeAccount"))}</button><button type="button" data-recovery-resend></button></div>`
            : phase === "password"
              ? identity +
                field(t("common.newPassword"), "password", password, "password") +
                field(t("common.confirmPassword"), "confirm", confirm, "password") +
                `<button type="submit">${e(t("users.setPassword"))}</button>`
              : `<a class="auth-recovery-login auth-primary-action" href="/">${e(t("users.backToLogin"))}</a>`),
    );
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!busy) void submit();
    };
    form.querySelector<HTMLButtonElement>("[data-recovery-back]")?.addEventListener("click", () => {
      if (busy) return;
      phase = "identify";
      failure = "";
      feedback = null;
      path("/reset-password");
      render();
    });
    form.querySelector<HTMLButtonElement>("[data-recovery-resend]")?.addEventListener("click", () => {
      void requestCode();
    });
    form.querySelector<HTMLInputElement>("#recovery-identifier")?.addEventListener("input", (event) => {
      draft.identifier = (event.target as HTMLInputElement).value;
    });
    for (const name of ["password", "confirm"])
      form.querySelector<HTMLInputElement>(`#recovery-${name}`)?.addEventListener("input", (event) => {
        if (name === "password") password = (event.target as HTMLInputElement).value;
        else confirm = (event.target as HTMLInputElement).value;
      });
    const input = form.querySelector<HTMLInputElement>("#recovery-code");
    input?.addEventListener("input", () => {
      code = input.value
        .normalize("NFKC")
        .replace(/[^0-9]/g, "")
        .slice(0, 6);
      input.value = code;
      failure = "";
      paintCode();
      notify();
      if (code.length === 6 && !busy)
        queueMicrotask(() => {
          if (!busy && phase === "code" && code.length === 6) form.requestSubmit();
        });
    });
    for (const name of ["focus", "click", "keyup", "select"]) input?.addEventListener(name, paintCode);
    input?.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") return;
      const box = input.parentElement!.getBoundingClientRect(),
        index = Math.min(code.length, 5, Math.max(0, Math.floor((event.clientX - box.left) / (box.width / 6))));
      event.preventDefault();
      input.focus();
      input.setSelectionRange(index, Math.min(code.length, index + 1));
      paintCode();
    });
    controls();
    paintCode();
    form.querySelector<HTMLElement>("input, .auth-recovery-login")?.focus();
  }
  async function requestCode() {
    if (busy || (phase === "code" && draft.resendAt > Date.now())) return;
    const generation = epoch;
    busy = true;
    feedback = "users.sendingCode";
    failure = "";
    controls();
    try {
      const result = await usersRequest<{ challengeId: string; retryAfter: number }>(
        t,
        "/api/local-users/reset/request",
        "POST",
        { identifier: draft.identifier },
        AbortSignal.timeout(35000),
      );
      if (disposed || generation !== epoch) return;
      draft = {
        identifier: draft.identifier,
        challengeId: result.challengeId,
        verificationId: result.challengeId === draft.challengeId ? draft.verificationId : crypto.randomUUID(),
        resendAt: Date.now() + result.retryAfter * 1000,
        expiresAt: Date.now() + 600_000,
      };
      persist();
      code = "";
      grant = "";
      phase = "code";
      feedback = "users.codeRequested";
      busy = false;
      path("/reset-password", true);
      render();
    } catch (error) {
      if (!disposed && generation === epoch) {
        feedback = null;
        failure = error instanceof Error ? error.message : t("users.unavailable");
      }
    } finally {
      if (!disposed && generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  async function submit() {
    if (phase === "identify") {
      draft.identifier = form.querySelector<HTMLInputElement>("#recovery-identifier")!.value.trim();
      await requestCode();
      return;
    }
    if (phase === "complete") return;
    if (phase === "code" && !/^[0-9]{6}$/.test(code)) {
      failure = t("users.invalidCode");
      notify();
      return;
    }
    if (phase === "password" && (!validAdministratorPassword(password) || password !== confirm)) {
      failure = t(password !== confirm ? "auth.passwordsDoNotMatch" : "users.passwordPolicy");
      notify();
      return;
    }
    const generation = epoch,
      current = phase;
    busy = true;
    failure = "";
    feedback = current === "code" ? "users.checkingCode" : "users.savingPassword";
    controls();
    try {
      if (current === "code") {
        const result = await usersRequest<{ token: string; email: string }>(
          t,
          "/api/local-users/reset/verify",
          "POST",
          { challengeId: draft.challengeId, code, verificationId: draft.verificationId },
          AbortSignal.timeout(35000),
        );
        if (disposed || generation !== epoch) return;
        grant = result.token;
        phase = "password";
        feedback = "users.codeVerified";
        path("/reset-password/new");
      } else {
        await usersRequest(
          t,
          "/api/local-users/reset/accept",
          "POST",
          { token: grant, password },
          AbortSignal.timeout(35000),
        );
        if (disposed || generation !== epoch) return;
        grant = "";
        code = "";
        password = "";
        confirm = "";
        phase = "complete";
        feedback = null;
        draft.challengeId = "";
        path("/reset-password", true);
        try {
          sessionStorage.removeItem(storageKey);
        } catch {}
      }
      busy = false;
      render();
    } catch (error) {
      if (!disposed && generation === epoch) {
        feedback = null;
        failure = error instanceof Error ? error.message : t("users.unavailable");
        const input = form.querySelector<HTMLInputElement>("#recovery-code");
        input?.focus();
        input?.select();
        paintCode();
      }
    } finally {
      if (!disposed && generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  const popstate = () => {
    if (location.pathname === "/reset-password/new" && grant) phase = "password";
    else phase = draft.challengeId ? "code" : "identify";
    busy = false;
    failure = "";
    feedback = null;
    render();
  };
  window.addEventListener("popstate", popstate);
  const unsubscribe = getBrowserI18n().subscribe(() => {
    if (!disposed && !busy) render();
  });
  const timer = setInterval(() => {
    if (!disposed) controls();
  }, 1000);
  const autoSend = draft.autoSend && draft.identifier;
  path("/reset-password", true);
  render();
  if (autoSend) void requestCode();
  return () => {
    disposed = true;
    epoch++;
    clearInterval(timer);
    unsubscribe();
    window.removeEventListener("popstate", popstate);
  };
}
