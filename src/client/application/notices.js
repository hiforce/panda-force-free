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
      icon.innerHTML = codexIcon("triangleAlert");
      icon.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      body.className = "persistent-error-body";
      const heading = document.createElement("strong");
      heading.textContent = t("Error");
      const message = document.createElement("p");
      message.textContent = error.message;
      body.append(heading, message);
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "persistent-error-dismiss";
      dismiss.setAttribute("aria-label", t("Dismiss error"));
      dismiss.title = t("Dismiss error");
      dismiss.innerHTML = codexIcon("x");
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
    const message = t(persistentErrorText(value)).trim();
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
    e.textContent = text;
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
      button.textContent = action.label;
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
