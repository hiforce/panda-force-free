const GLOBAL_KEY = "__pandaForceWorkspacePreparation";
const STEPS = [
  ["interface", "Preparing the interface"],
  ["connection", "Connecting to your workspace"],
  ["configuration", "Loading workspace settings"],
  ["projects", "Loading projects"],
  ["sessions", "Loading recent sessions"],
  ["models", "Loading available models"],
  ["permissions", "Loading permissions"],
];

export function createWorkspacePreparation({
  root = globalThis.document,
  translate = (message, values = {}) => message.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`),
  now = () => Date.now(),
  slowAfterMs = 5000,
  timeoutMs = 45000,
  onReload = () => globalThis.location.reload(),
} = {}) {
  const panel = root?.querySelector("#workspacePreparation");
  const steps = new Map(STEPS.map(([id, label]) => [id, { label, status: "waiting", version: 0 }]));
  let started = false,
    finished = false,
    dismissed = false,
    startedAt = 0,
    timer,
    hideTimer;
  const rows = new Map();
  const listeners = new Set(),
    retries = new Map();
  const snapshot = () => ({
    finished,
    dismissed,
    steps: [...steps].map(([id, step]) => ({ id, label: step.label, status: step.status })),
  });
  if (panel) {
    const list = panel.querySelector(".workspace-preparation-steps");
    for (const [id, step] of steps) {
      const row = root.createElement("li"),
        mark = root.createElement("span"),
        label = root.createElement("span");
      row.dataset.step = id;
      mark.className = "preparation-step-mark";
      mark.setAttribute("aria-hidden", "true");
      label.className = "preparation-step-label";
      row.append(mark, label);
      list.append(row);
      rows.set(id, { row, mark, label });
    }
    panel.querySelector("#workspacePreparationReload").onclick = onReload;
    const retry = panel.querySelector("#workspacePreparationRetry");
    if (retry) retry.onclick = () => api.retry();
    panel.querySelector("#workspacePreparationContinue").onclick = () => {
      if (steps.get("interface").status === "ready") {
        dismissed = true;
        render();
      }
    };
  }
  function syncShell(blocked) {
    root.body?.classList.toggle("workspace-booting", blocked);
    const app = root.querySelector("#app");
    if (app) {
      app.inert = blocked;
      if (blocked) app.setAttribute("aria-hidden", "true");
      else app.removeAttribute("aria-hidden");
    }
  }
  function render() {
    if (!panel || !started) return;
    for (const listener of listeners) listener(snapshot());
    syncShell(!dismissed);
    if (dismissed) {
      const returnFocus = panel.contains(root.activeElement);
      panel.hidden = true;
      if (returnFocus) root.querySelector("#prompt")?.focus({ preventScroll: true });
      return;
    }
    const ready = [...steps.values()].filter((step) => step.status === "ready").length;
    const failed = [...steps.values()].some((step) => step.status === "error");
    const slow = now() - startedAt >= slowAfterMs;
    panel.hidden = dismissed;
    panel.dataset.status = finished ? "ready" : failed ? "error" : "loading";
    panel.setAttribute("aria-busy", String(!finished));
    panel.querySelector("#workspacePreparationTitle").textContent = translate(
      finished ? "Your workspace is ready" : "Preparing your workspace",
    );
    const message = translate(
      finished
        ? "Everything is ready. You can get started."
        : failed
          ? "Some information could not be loaded. Reload to try again."
          : slow
            ? "Still loading. Your workspace is taking a little longer to respond."
            : "Getting your projects, sessions and tools ready.",
    );
    const messageElement = panel.querySelector("#workspacePreparationMessage");
    if (messageElement.textContent !== message) messageElement.textContent = message;
    const progress = panel.querySelector("#workspacePreparationProgress");
    progress.max = steps.size;
    progress.value = ready;
    const count = translate("{completed} of {total} steps ready", { completed: ready, total: steps.size });
    progress.setAttribute("aria-valuetext", count);
    panel.querySelector("#workspacePreparationCount").textContent = count;
    panel.querySelector("#workspacePreparationElapsed").textContent = translate("Elapsed: {seconds}s", {
      seconds: Math.floor((now() - startedAt) / 1000),
    });
    panel.querySelector("#workspacePreparationElapsed").hidden = !slow;
    const reload = panel.querySelector("#workspacePreparationReload");
    reload.hidden = !failed && !slow;
    reload.textContent = translate("Reload workspace");
    const retry = panel.querySelector("#workspacePreparationRetry");
    if (retry) {
      retry.hidden = !failed && !slow;
      retry.textContent = translate("Retry remaining steps");
    }
    const proceed = panel.querySelector("#workspacePreparationContinue");
    proceed.disabled = steps.get("interface").status !== "ready";
    proceed.textContent = translate("Continue to workspace");
    for (const [id, step] of steps) {
      const { row, mark, label } = rows.get(id);
      row.dataset.status = step.status;
      mark.textContent = step.status === "ready" ? "✓" : step.status === "error" ? "!" : "";
      label.textContent = translate(step.label);
    }
  }
  function settle() {
    if (finished || ![...steps.values()].every((step) => step.status === "ready")) return;
    finished = true;
    clearInterval(timer);
    render();
    hideTimer = setTimeout(() => {
      dismissed = true;
      render();
    }, 400);
  }
  function update(id, status) {
    if (!started || finished || !steps.has(id)) return;
    steps.get(id).status = status;
    render();
    settle();
  }
  const api = {
    begin() {
      if (started) return;
      started = true;
      startedAt = now();
      steps.get("interface").status = "loading";
      render();
      panel?.setAttribute("tabindex", "-1");
      panel?.focus({ preventScroll: true });
      timer = setInterval(() => {
        if (now() - startedAt >= timeoutMs) {
          for (const step of steps.values()) if (step.status !== "ready") step.status = "error";
          clearInterval(timer);
        }
        render();
      }, 1000);
    },
    start(id) {
      update(id, "loading");
    },
    complete(id) {
      update(id, "ready");
    },
    fail(id) {
      update(id, "error");
    },
    track(id, pending) {
      if (!started || finished || !steps.has(id) || steps.get(id).status === "ready") return pending;
      const version = ++steps.get(id).version;
      update(id, "loading");
      return Promise.resolve(pending).then(
        (value) => {
          if (steps.get(id).version === version) update(id, value === false ? "error" : "ready");
          return value;
        },
        (error) => {
          if (steps.get(id).version === version) update(id, error?.silentTransportSwitch ? "loading" : "error");
          throw error;
        },
      );
    },
    registerRetry(id, callback) {
      if (steps.has(id)) retries.set(id, callback);
    },
    retry() {
      const pending = [];
      for (const [id, step] of steps) {
        if (step.status === "ready" || !retries.has(id)) continue;
        step.status = "loading";
        pending.push(api.track(id, Promise.resolve().then(retries.get(id))));
      }
      render();
      return Promise.allSettled(pending);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    snapshot,
    refresh: render,
    dispose() {
      clearInterval(timer);
      clearTimeout(hideTimer);
    },
  };
  return api;
}

export function getWorkspacePreparation() {
  return (globalThis[GLOBAL_KEY] ||= createWorkspacePreparation({
    translate: (message, values) => globalThis.__pandaForceI18n?.t(message, values) ?? message,
  }));
}
