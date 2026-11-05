import { errorText, localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "../i18n.js";
import { createLifecycle } from "../lifecycle.js";

import { codexIcon } from "../codex-icons.js";

// Owns persistent notices and transient toast actions.
/** @param {import("./ports.js").FeatureOptions<"mutations" | "$" | "state" | "t", never, "notices">} options */
export function assembleNotices({ mutations, $, state, t }) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let toastTimer;
  /** @type {{label: string; project?: string; run: () => unknown} | null} */
  let toastAction = null;
  let toastEvents = createLifecycle();
  function renderPersistentErrors() {
    const root = $("#persistentErrors");
    if (!root) return;
    root.replaceChildren();
    root.hidden = !state.persistentErrors.length;
    for (const error of state.persistentErrors) {
      const card = document.createElement("article");
      card.className = "persistent-error";
      card.dataset.errorId = error.id;
      card.setAttribute("role", "alert");
      const icon = document.createElement("span");
      icon.className = "persistent-error-icon";
      setMessageHtml(icon, codexIcon("triangleAlert"));
      icon.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      body.className = "persistent-error-body";
      const heading = document.createElement("strong");
      localizeText(heading, "workbench.error", undefined, t);
      const message = document.createElement("p");
      setOpaqueText(message, error.message);
      body.append(heading, message);
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "persistent-error-dismiss";
      localizeAttribute(dismiss, "aria-label", "workbench.dismissError", undefined, t);
      localizeAttribute(dismiss, "title", "workbench.dismissError", undefined, t);
      setMessageHtml(dismiss, codexIcon("x"));
      dismiss.onclick = () => {
        mutations.set(
          "persistentErrors",
          state.persistentErrors.filter((item) => item.id !== error.id),
        );
        renderPersistentErrors();
      };
      card.append(icon, body, dismiss);
      root.append(card);
    }
  }
  /** @param {unknown} value @param {{key?: string}} options */
  function addPersistentError(value, { key } = {}) {
    const message = errorText(value, t).trim();
    if (!message || message === "Bridge transport changed") return;
    const identity = key || message;
    const existing = state.persistentErrors.find((error) => error.key === identity);
    if (existing) {
      mutations.edit("persistentErrors", (errors) => {
        const error = errors.find((entry) => entry.id === existing.id);
        if (error) error.message = message;
      });
      renderPersistentErrors();
      return;
    }
    mutations.edit("persistentErrors", (record) =>
      record.push({ id: `error-${Date.now()}-${state.persistentErrors.length}`, key: identity, message }),
    );
    renderPersistentErrors();
  }
  function dismissToast() {
    clearTimeout(toastTimer);
    toastAction = null;
    toastEvents.dispose();
    const e = $("#toast");
    e.classList.remove("show", "has-action");
    e.replaceChildren();
  }
  /** @param {string} text @param {number} duration @param {{label: string; project?: string; run: () => unknown} | null} action */
  function toast(text, duration = 2200, action = null) {
    const e = $("#toast");
    setOpaqueText(e, text);
    e.classList.toggle("has-action", Boolean(action));
    toastAction = action;
    toastEvents.dispose();
    toastEvents = createLifecycle();
    const expire = () => {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(dismissToast, duration);
    };
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toast-action";
      setOpaqueText(button, action.label);
      button.onclick = async () => {
        button.disabled = true;
        await action.run();
      };
      e.append(button);
    }
    toastEvents.on(e, "focusin", () => clearTimeout(toastTimer));
    toastEvents.on(e, "focusout", expire);
    e.onmouseenter = () => clearTimeout(toastTimer);
    e.onmouseleave = expire;
    e.classList.add("show");
    expire();
  }
  return {
    getToastProject: () => toastAction?.project || null,
    addPersistentError,
    toast,
    dismissToast,
    renderPersistentErrors,
  };
}
