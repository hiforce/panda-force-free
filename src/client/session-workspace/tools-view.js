import { codexIcon } from "../codex-icons.js";
import { escapeHtml } from "../../shared/html.js";
import { localizeAttribute, localizeText, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { closestElement, findElement, requireElement } from "../dom.js";

/** Tools own browser-only data; registry actions delegate engine work to existing application ports. */
export function createSessionToolsView({ registry, store, t, openDialog, readSessionId, toast }) {
  let signature = "",
    localTool = "",
    localSessionId = "";
  const enabled = () => registry.all().filter((tool) => !store.preferences().disabled.includes(tool.id));
  const text = (key) => messageHtml(key, undefined, t);
  const toolButton = (tool, short = false) =>
    `<button type="button" class="${short ? "session-tool-shortcut" : "session-tool-open"}" data-session-tool="${tool.id}">${codexIcon(tool.icon)}<span><strong>${text(tool.title)}</strong>${short ? "" : `<small>${text(tool.description)}</small>`}</span></button>`;
  function renderList() {
    const query = requireElement("#sessionToolSearch").value.trim().toLocaleLowerCase();
    const pinned = store.preferences().pinned;
    setMessageHtml(
      requireElement("#sessionToolsList"),
      enabled()
        .filter((tool) => t(tool.title).toLocaleLowerCase().includes(query))
        .map(
          (tool) =>
            `<div class="session-tool-row">${toolButton(tool)}<button type="button" class="icon-button session-pin-tool" data-session-pin="${tool.id}" aria-pressed="${pinned.includes(tool.id)}" aria-label="${escapeHtml(t(pinned.includes(tool.id) ? "sessionview.unpin" : "sessionview.pin", { tool: t(tool.title) }))}">${codexIcon("pin")}</button></div>`,
        )
        .join("") || `<p class="session-caption">${text("sessionview.noMatchingTools")}</p>`,
    );
  }
  function render(locale) {
    const preferences = store.preferences();
    if (localTool && preferences.disabled.includes(localTool)) back();
    const next = JSON.stringify([preferences, locale]);
    setOpaqueText(requireElement("#sessionToolsCount"), String(enabled().length));
    if (next !== signature) {
      signature = next;
      setMessageHtml(
        requireElement("#sessionToolShortcuts"),
        preferences.pinned
          .map((id) => registry.get(id))
          .filter(Boolean)
          .map((tool) => toolButton(tool, true))
          .join(""),
      );
      renderList();
    }
    const id = readSessionId();
    if (localTool && id !== localSessionId) showLocal(localTool);
    if (localTool === "notes") {
      localizeAttribute(findElement("#sessionNoteInput"), "placeholder", "sessionview.notePlaceholder", undefined, t);
      localizeAttribute(findElement("#sessionNoteInput"), "aria-label", "sessionview.notes", undefined, t);
    }
    if (localTool === "checklist") {
      localizeAttribute(
        findElement("#sessionChecklistInput"),
        "placeholder",
        "sessionview.checkPlaceholder",
        undefined,
        t,
      );
      localizeAttribute(
        findElement("#sessionChecklistInput"),
        "aria-label",
        "sessionview.checkPlaceholder",
        undefined,
        t,
      );
    }
  }
  function pin(id) {
    const restoreFocus =
      document.activeElement ===
      findElement(`[data-session-pin="${CSS.escape(id)}"]`, requireElement("#sessionToolsList"));
    if (!store.pin(id)) toast(t("sessionview.pinLimit"));
    signature = "";
    render("");
    if (restoreFocus)
      findElement(`[data-session-pin="${CSS.escape(id)}"]`, requireElement("#sessionToolsList"))?.focus({
        preventScroll: true,
      });
  }
  function manager() {
    const wasOpen = requireElement("#sessionToolsDialog").open;
    const focused = closestElement(
      "[data-session-move], [data-session-pin], [data-session-enable]",
      document.activeElement,
    );
    const focusQuery = focused
      ? ["data-session-move", "data-session-pin", "data-session-enable", "data-direction"]
          .filter((name) => focused.hasAttribute(name))
          .map((name) => `[${name}="${CSS.escape(focused.getAttribute(name) || "")}"]`)
          .join("")
      : "";
    const preferences = store.preferences();
    const rows = preferences.pinned
      .map((id, index) => {
        const tool = registry.get(id);
        if (!tool) return "";
        return `<div class="session-manager-row">${codexIcon(tool.icon)}<strong>${text(tool.title)}</strong><button type="button" class="icon-button" data-session-move="${id}" data-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="${escapeHtml(t("sessionview.moveUp", { tool: t(tool.title) }))}">${codexIcon("chevronUp")}</button><button type="button" class="icon-button" data-session-move="${id}" data-direction="1" ${index === preferences.pinned.length - 1 ? "disabled" : ""} aria-label="${escapeHtml(t("sessionview.moveDown", { tool: t(tool.title) }))}">${codexIcon("chevronDown")}</button><button type="button" class="icon-button" data-session-pin="${id}" aria-label="${escapeHtml(t("sessionview.unpin", { tool: t(tool.title) }))}">${codexIcon("x")}</button></div>`;
      })
      .join("");
    setMessageHtml(
      requireElement("#sessionToolsManager"),
      `<p class="session-caption">${text("sessionview.toolHint")}</p><h3 class="session-section-label">${text("sessionview.pinned")}</h3>${rows}<h3 class="session-section-label">${text("sessionview.availableTools")}</h3>${registry
        .all()
        .map(
          (tool) =>
            `<label class="session-manager-row"><span>${codexIcon(tool.icon)}</span><span><strong>${text(tool.title)}</strong><small>${text(tool.description)}</small></span><input type="checkbox" data-session-enable="${tool.id}" ${preferences.disabled.includes(tool.id) ? "" : "checked"} aria-label="${escapeHtml(t("sessionview.enable", { tool: t(tool.title) }))}" /></label>`,
        )
        .join("")}`,
    );
    openDialog(requireElement("#sessionToolsDialog"));
    if (wasOpen && focusQuery) {
      const next = findElement(focusQuery, requireElement("#sessionToolsManager"));
      if (next && !(next instanceof HTMLButtonElement && next.disabled)) next.focus({ preventScroll: true });
    }
  }
  function writeDocument() {
    const id = localSessionId;
    if (!id || id !== readSessionId()) return;
    const document = store.document(id);
    if (localTool === "notes") document.note = requireElement("#sessionNoteInput").value;
    const persisted = store.saveDocument(id, document);
    localizeText(
      findElement("#sessionToolSaveState"),
      persisted ? "sessionview.localSaved" : "sessionview.tabOnly",
      undefined,
      t,
    );
  }
  function renderChecks() {
    const document = store.document(localSessionId);
    setMessageHtml(
      requireElement("#sessionChecklistItems"),
      document.checks
        .map(
          (item) =>
            `<div class="session-checklist-item"><label><input type="checkbox" data-session-check="${escapeHtml(item.id)}" ${item.done ? "checked" : ""}/><span>${escapeHtml(item.text)}</span></label><button type="button" class="icon-button" data-session-remove-check="${escapeHtml(item.id)}" aria-label="${escapeHtml(t("sessionview.removeItem", { item: item.text }))}">${codexIcon("x")}</button></div>`,
        )
        .join(""),
    );
  }
  function showLocal(id) {
    localTool = id;
    localSessionId = readSessionId();
    const tool = registry.get(id);
    if (!tool) return;
    requireElement("#sessionToolsListView").hidden = true;
    const root = requireElement("#sessionLocalTool");
    root.hidden = false;
    const document = store.document(localSessionId);
    setMessageHtml(
      root,
      `<div class="session-local-tool-heading"><button type="button" class="icon-button" data-session-action="back-tools" aria-label="${escapeHtml(t("sessionview.backToTools"))}">${codexIcon("arrowLeft")}</button><h3>${text(tool.title)}</h3></div><p class="session-caption">${text(tool.description)}</p>${id === "notes" ? `<textarea class="session-field session-note" id="sessionNoteInput" maxlength="20000" aria-label="${escapeHtml(t("sessionview.notes"))}" placeholder="${escapeHtml(t("sessionview.notePlaceholder"))}" ${localSessionId ? "" : "disabled"}>${escapeHtml(document.note)}</textarea>` : `<div id="sessionChecklistItems"></div><form id="sessionChecklistForm"><input class="session-field" id="sessionChecklistInput" maxlength="250" required placeholder="${escapeHtml(t("sessionview.checkPlaceholder"))}" aria-label="${escapeHtml(t("sessionview.checkPlaceholder"))}" ${localSessionId ? "" : "disabled"}/><button class="session-button" type="submit" ${localSessionId ? "" : "disabled"}>${text("sessionview.addItem")}</button></form>`}<p class="session-caption" id="sessionToolSaveState"></p>`,
    );
    if (id === "checklist") renderChecks();
  }
  function back() {
    localTool = "";
    localSessionId = "";
    requireElement("#sessionToolsListView").hidden = false;
    requireElement("#sessionLocalTool").hidden = true;
  }
  function activate(id) {
    const tool = registry.get(id);
    if (!tool || store.preferences().disabled.includes(id)) return;
    if (id === "notes" || id === "checklist") showLocal(id);
    else tool.activate();
  }
  function click(event) {
    const pinButton = closestElement("[data-session-pin]", event.target);
    if (pinButton) {
      pin(pinButton.dataset.sessionPin);
      if (requireElement("#sessionToolsDialog").open) manager();
    }
    const move = closestElement("[data-session-move]", event.target);
    if (move) {
      store.move(move.dataset.sessionMove, Number(move.dataset.direction));
      signature = "";
      render("");
      manager();
    }
    const remove = closestElement("[data-session-remove-check]", event.target);
    if (remove && localSessionId === readSessionId()) {
      const document = store.document(localSessionId);
      document.checks = document.checks.filter((item) => item.id !== remove.dataset.sessionRemoveCheck);
      store.saveDocument(localSessionId, document);
      renderChecks();
    }
  }
  function change(event) {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    if (field.dataset.sessionEnable) {
      store.enable(field.dataset.sessionEnable, field.checked);
      signature = "";
      render("");
      manager();
    }
    if (field.dataset.sessionCheck && localSessionId === readSessionId()) {
      const document = store.document(localSessionId);
      const item = document.checks.find((item) => item.id === field.dataset.sessionCheck);
      if (item) {
        item.done = field.checked;
        store.saveDocument(localSessionId, document);
      }
    }
  }
  function input(event) {
    if (event.target === findElement("#sessionNoteInput")) writeDocument();
    if (event.target === requireElement("#sessionToolSearch")) renderList();
  }
  function submit(event) {
    if (event.target !== findElement("#sessionChecklistForm")) return;
    event.preventDefault();
    if (localSessionId !== readSessionId()) return;
    const input = requireElement("#sessionChecklistInput"),
      value = input.value.trim(),
      document = store.document(localSessionId);
    if (!value || document.checks.length >= 30) return;
    document.checks.push({ id: crypto.randomUUID(), text: value, done: false });
    store.saveDocument(localSessionId, document);
    input.value = "";
    renderChecks();
    input.focus();
  }
  return { render, manager, activate, back, click, change, input, submit, showLocal };
}
