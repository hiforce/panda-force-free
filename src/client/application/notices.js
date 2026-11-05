import { localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "../i18n.js";

import { codexIcon } from "../codex-icons.js";

// Owns persistent notices and transient toast actions.
export function assembleNotices({ mutations, $, state, t }) {
  function persistentErrorText(value) {
    if (value && typeof value === "object") {
      const message = String(value.message || value.error?.message || value.error || "Unexpected error");
      return value.additionalDetails ? `${message}\n${value.additionalDetails}` : message;
    }
    return String(value || "Unexpected error");
  }
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
  function addPersistentError(value, { key } = {}) {
    const message = (value?.messageId ? t(value.messageId, value.messageArgs) : persistentErrorText(value)).trim();
    if (!message || message === "Bridge transport changed") return;
    const identity = key || message;
    const existing = state.persistentErrors.find((error) => error.key === identity);
    if (existing) {
      existing.message = message;
      renderPersistentErrors();
      return;
    }
    mutations.edit("persistentErrors", (record) =>
      record.push({ id: `error-${Date.now()}-${state.persistentErrors.length}`, key: identity, message }),
    );
    renderPersistentErrors();
  }
  function dismissToast() {
    clearTimeout(toast.t);
    toast.project = null;
    const e = $("#toast");
    e.classList.remove("show", "has-action");
    e.replaceChildren();
  }
  function toast(text, duration = 2200, action = null) {
    const e = $("#toast");
    setOpaqueText(e, text);
    e.classList.toggle("has-action", Boolean(action));
    toast.project = action?.project || null;
    const expire = () => {
      clearTimeout(toast.t);
      toast.t = setTimeout(dismissToast, duration);
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
    e.onfocusin = () => clearTimeout(toast.t);
    e.onfocusout = expire;
    e.onmouseenter = () => clearTimeout(toast.t);
    e.onmouseleave = expire;
    e.classList.add("show");
    expire();
  }
  return {
    addPersistentError,
    toast,
    dismissToast,
    renderPersistentErrors,
  };
}
