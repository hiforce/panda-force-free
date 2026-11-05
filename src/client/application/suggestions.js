import { slashCommandCatalog } from "./command-catalog.js";
import { applyComposerSuggestion, getComposerAutocomplete } from "../ui-core.js";
import { codexIcon } from "../codex-icons.js";

// Owns autocomplete requests, selection and context chips using the shared command catalog.
export function assembleSuggestions({
  viewUpdates,
  mutations,
  $,
  escapeHtml,
  state,
  titleOf,
  shortPath,
  t,
  workspacePort,
  modelsPort,
  composerPort,
  noticesPort,
  commandsPort,
}) {
  const autocompleteState = {
    match: null,
    items: [],
    selected: 0,
    requestId: 0,
    message: "",
  };

  function closeComposerAutocomplete() {
    const menu = $("#composerAutocomplete");
    autocompleteState.requestId++;
    menu.hidden = true;
    menu.replaceChildren();
    delete menu.dataset.type;
    autocompleteState.match = null;
    autocompleteState.items = [];
    autocompleteState.selected = 0;
    autocompleteState.message = "";
  }
  function renderComposerAutocomplete() {
    const menu = $("#composerAutocomplete"),
      items = autocompleteState.items;
    menu.innerHTML = "";
    menu.dataset.type = autocompleteState.match?.type || "";
    menu.setAttribute("aria-label", autocompleteState.match?.type === "slash" ? "Slash command menu" : "Mention menu");
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "autocomplete-empty";
      empty.textContent =
        autocompleteState.message ||
        (autocompleteState.match?.type === "mention" ? "Type to search for files" : "No commands");
      menu.append(empty);
    } else
      for (const [index, item] of items.entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "autocomplete-item" + (index === autocompleteState.selected ? " selected" : "");
        button.dataset.autocompleteId = item.id;
        button.role = "option";
        button.setAttribute("aria-selected", String(index === autocompleteState.selected));
        button.innerHTML = `${codexIcon(item.icon || "file")}<span class="autocomplete-copy"><strong class="autocomplete-title">${escapeHtml(item.title)}</strong><small class="autocomplete-description">${escapeHtml(item.description)}</small></span>`;
        button.onpointerdown = (event) => event.preventDefault();
        button.onclick = () => selectComposerAutocomplete(index);
        menu.append(button);
      }
    menu.hidden = false;
  }
  function currentComposerCwd() {
    if (state.projectless && !state.active) return "";
    const path = state.active?.cwd || $("#projectPath").textContent || state.config.defaultCwd;
    return path.startsWith("~") ? state.config.home + path.slice(1) : path;
  }
  async function searchMentionSuggestions(match) {
    const query = match.query.trim(),
      requestId = ++autocompleteState.requestId;
    if (!query) {
      autocompleteState.items = [];
      autocompleteState.message =
        state.projectless && !state.active ? "Choose a project to mention files" : "Type to search for files";
      renderComposerAutocomplete();
      return;
    }
    const tasks = state.threads
        .filter((thread) => titleOf(thread).toLowerCase().includes(query.toLowerCase()))
        .slice(0, 5)
        .map((thread) => ({
          id: `task:${thread.id}`,
          source: "task",
          threadId: thread.id,
          title: titleOf(thread),
          description: `Task · ${shortPath(thread.cwd)}`,
          icon: "messageSquare",
        })),
      cwd = currentComposerCwd();
    if (!cwd) {
      autocompleteState.items = [
        {
          id: "choose-project",
          source: "action",
          title: "Choose project",
          description: "Select a project to mention files",
          icon: "folderOpen",
        },
        ...tasks,
      ];
      autocompleteState.selected = 0;
      autocompleteState.message = "";
      renderComposerAutocomplete();
      return;
    }
    autocompleteState.items = [];
    autocompleteState.message = "Searching files…";
    renderComposerAutocomplete();
    try {
      const response = await fetch(
          `/api/files/search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}`,
          { cache: "no-store" },
        ),
        data = await response.json();
      if (!response.ok) throw new Error(data.error || "File search unavailable");
      if (
        requestId !== autocompleteState.requestId ||
        autocompleteState.match?.type !== "mention" ||
        autocompleteState.match.query !== match.query
      )
        return;
      const files = (data.items || []).map((item) => {
        const parts = item.path.split("/");
        return {
          id: `${item.kind}:${item.path}`,
          source: item.kind,
          path: item.path,
          title: parts.at(-1),
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : item.kind === "folder" ? "Folder" : "File",
          icon: item.kind === "folder" ? "folderOpen" : "file",
        };
      });
      autocompleteState.items = [...files, ...tasks];
      autocompleteState.selected = 0;
      autocompleteState.message = autocompleteState.items.length ? "" : "No files or tasks found";
      renderComposerAutocomplete();
    } catch (error) {
      if (requestId !== autocompleteState.requestId) return;
      autocompleteState.items = tasks;
      autocompleteState.message = tasks.length ? "" : error.message;
      renderComposerAutocomplete();
    }
  }
  function updateComposerAutocomplete() {
    const input = $("#prompt"),
      match = getComposerAutocomplete(input.value, input.selectionStart ?? input.value.length);
    if (!match) {
      closeComposerAutocomplete();
      return;
    }
    autocompleteState.match = match;
    autocompleteState.selected = 0;
    if (match.type === "slash") {
      autocompleteState.requestId++;
      const query = match.query.trim().toLowerCase();
      autocompleteState.items = slashCommandCatalog.filter(
        (item) =>
          (!item.requiresThread || state.active) &&
          (item.id.includes(query) || item.title.toLowerCase().includes(query)),
      );
      autocompleteState.message = "";
      renderComposerAutocomplete();
      return;
    }
    searchMentionSuggestions(match);
  }
  function moveComposerAutocomplete(delta) {
    if (!autocompleteState.items.length) return;
    autocompleteState.selected =
      (autocompleteState.selected + delta + autocompleteState.items.length) % autocompleteState.items.length;
    renderComposerAutocomplete();
  }

  function applyAutocompleteToken(match, replacement) {
    const input = $("#prompt"),
      result = applyComposerSuggestion(input.value, match, replacement);
    input.value = result.text;
    input.setSelectionRange(result.cursor, result.cursor);
    viewUpdates.request("composerLayout");
  }
  function renderContextTray() {
    const tray = $("#composerContextTray");
    tray.innerHTML = "";
    for (const mention of state.composerMentions) {
      const chip = document.createElement("div");
      chip.className = "composer-context-chip";
      chip.dataset.contextId = mention.id;
      chip.innerHTML = `${codexIcon(mention.icon || "file")}<span>${escapeHtml(mention.title)}</span><button type="button" aria-label="Remove ${escapeHtml(mention.title)}">${codexIcon("x")}</button>`;
      chip.querySelector("button").onclick = () => {
        mutations.set(
          "composerMentions",
          state.composerMentions.filter((item) => item.id !== mention.id),
        );
        renderContextTray();
      };
      tray.append(chip);
    }
    tray.hidden = !state.composerMentions.length;
    viewUpdates.request("composerDraft");
  }
  function selectComposerAutocomplete(index = autocompleteState.selected) {
    const item = autocompleteState.items[index],
      match = autocompleteState.match;
    if (!item || !match) return;
    const id = item.id;
    if (item.source === "action" && id === "choose-project") {
      closeComposerAutocomplete();
      workspacePort.openFolderPicker();
    } else if (item.source === "file" || item.source === "folder") {
      applyAutocompleteToken(match, `@${item.path}`);
      if (!state.composerMentions.some((mention) => mention.id === item.id))
        mutations.edit("composerMentions", (record) => record.push({ ...item }));
      renderContextTray();
      closeComposerAutocomplete();
    } else if (item.source === "task") {
      applyAutocompleteToken(match, `@${item.title}`);
      if (!state.composerMentions.some((mention) => mention.id === item.id))
        mutations.edit("composerMentions", (record) => record.push({ ...item }));
      renderContextTray();
      closeComposerAutocomplete();
    } else {
      closeComposerAutocomplete();
      if (id === "init") {
        noticesPort.toast("Init requires the native command bridge.");
      } else if (id === "goal") {
        if (state.active) {
          $("#prompt").value = "/goal ";
          viewUpdates.request("composerLayout");
        } else noticesPort.toast(t("Start a task first"));
      } else if (["compact", "fork", "review", "side", "fast", "feedback"].includes(id)) {
        void commandsPort.submitNativeSlashCommand(state.active, id);
      } else if (id === "plan") {
        composerPort.setPlanMode(!state.planMode);
        $("#prompt").value = "";
        viewUpdates.request("composerLayout");
      } else if (id === "model") {
        $("#prompt").value = "";
        viewUpdates.request("composerLayout");
        modelsPort.openModelMenu();
      } else if (id === "reasoning") {
        $("#prompt").value = "";
        viewUpdates.request("composerLayout");
        modelsPort.openModelMenu();
      } else if (id === "project") {
        $("#prompt").value = "";
        viewUpdates.request("composerLayout");
        workspacePort.openFolderPicker();
      } else if (id === "mcp") {
        $("#prompt").value = "";
        viewUpdates.request("composerLayout");
        noticesPort.toast("MCP status requires the native desktop status surface.");
      } else if (id === "status") {
        $("#prompt").value = "";
        viewUpdates.request("composerLayout");
        noticesPort.toast(state.active?.id ? `Task ${state.active.id}` : "No active task");
      }
    }
    requestAnimationFrame(() => $("#prompt").focus());
  }
  return {
    closeComposerAutocomplete,
    renderContextTray,
    updateComposerAutocomplete,
    moveComposerAutocomplete,
    selectComposerAutocomplete,
  };
}
