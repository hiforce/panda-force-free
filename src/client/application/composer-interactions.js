import { localizeText } from "../i18n.js";

/** @param {import("./ports.js").FeatureOptions<"mutations" | "state" | "$" | "t", "composer" | "suggestions" | "uploads" | "queue" | "submission" | "workspace", "composerInteractions">} options */
export function assembleComposerInteractions({
  mutations,
  state,
  $,
  t,
  composerPort,
  suggestionsPort,
  uploadsPort,
  queuePort,
  submissionPort,
  workspacePort,
}) {
  const historyStatus = document.createElement("p");
  historyStatus.className = "composer-history-status";
  historyStatus.setAttribute("role", "status");
  historyStatus.hidden = true;
  let historyGeneration = 0;
  let pendingHistory = /** @type {{generation: number} | null} */ (null);
  function applyHistory(entry) {
    const input = $("#prompt");
    input.value = entry.text;
    input.setSelectionRange(entry.text.length, entry.text.length);
    mutations.set("composerMentions", entry.mentions || []);
    mutations.set("composerAttachments", entry.attachments || []);
    uploadsPort.renderComposerAttachments();
    suggestionsPort.closeComposerAutocomplete();
    suggestionsPort.renderContextTray();
    composerPort.resizePrompt();
  }
  function handlePromptInput(event) {
    historyGeneration++;
    historyStatus.hidden = true;
    composerPort.persistComposerDraft();
    composerPort.resizePrompt();
    if (!composerPort.promptComposing && !event?.isComposing) suggestionsPort.updateComposerAutocomplete();
  }
  function handlePromptKeydown(event) {
    if (pendingHistory && event.key !== "ArrowUp") {
      historyGeneration++;
      historyStatus.hidden = true;
    }
    // IME candidate confirmation must not submit or select a composer suggestion.
    // Some browsers report the final composition key with keyCode 229 only.
    if (composerPort.promptComposing || event.isComposing || event.keyCode === 229) return;
    const open = !$("#composerAutocomplete").hidden;
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        suggestionsPort.moveComposerAutocomplete(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        suggestionsPort.selectComposerAutocomplete();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        suggestionsPort.closeComposerAutocomplete();
        return;
      }
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const input = $("#prompt"),
        entry = composerPort.composerHistory.navigate(
          event.key === "ArrowUp" ? -1 : 1,
          input.value,
          input.selectionStart,
          input.selectionEnd,
        );
      if (entry) {
        event.preventDefault();
        applyHistory(entry);
        return;
      }
      if (
        event.key === "ArrowUp" &&
        composerPort.composerHistory.canReadOlder(input.value, input.selectionStart, input.selectionEnd)
      ) {
        event.preventDefault();
        if (pendingHistory) return;
        const scope = { href: location.href, thread: state.active?.id, project: state.newSessionProjectId };
        const value = input.value,
          start = input.selectionStart,
          end = input.selectionEnd;
        const pending = (pendingHistory = { generation: historyGeneration });
        const current = () =>
          pending.generation === historyGeneration &&
          scope.href === location.href &&
          scope.thread === state.active?.id &&
          scope.project === state.newSessionProjectId &&
          document.activeElement === input &&
          input.value === value &&
          input.selectionStart === start &&
          input.selectionEnd === end;
        historyStatus.hidden = false;
        localizeText(historyStatus, "composer.historyLoading", {}, t);
        void composerPort
          .loadComposerHistory()
          .then(
            () => {
              if (!current()) return;
              const restored = composerPort.composerHistory.navigate(-1, value, start, end);
              if (restored) {
                applyHistory(restored);
                historyStatus.hidden = true;
              } else localizeText(historyStatus, "composer.historyEmpty", {}, t);
            },
            () => {
              if (current()) localizeText(historyStatus, "composer.historyUnavailable", {}, t);
            },
          )
          .finally(() => {
            if (!current()) historyStatus.hidden = true;
            if (pendingHistory === pending) pendingHistory = null;
          });
        return;
      }
    }
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      composerPort.canQueuePrompt() &&
      ($("#prompt").value.trim() || state.composerAttachments.length)
    ) {
      event.preventDefault();
      queuePort.queuePrompt();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#composer").requestSubmit();
    }
  }
  function bind() {
    $("#composer").append(historyStatus);
    $("#composer").addEventListener("composer:scope-changed", () => {
      historyGeneration++;
      historyStatus.hidden = true;
    });
    $("#composer").addEventListener(
      "submit",
      /** @param {Parameters<typeof submissionPort.submitPrompt>} args */ (...args) =>
        submissionPort.submitPrompt(...args),
    );
    $("#prompt").addEventListener(
      "input",
      /** @param {Parameters<typeof handlePromptInput>} args */ (...args) => handlePromptInput(...args),
    );
    $("#prompt").addEventListener(
      "keydown",
      /** @param {Parameters<typeof handlePromptKeydown>} args */ (...args) => handlePromptKeydown(...args),
    );
    $("#prompt").addEventListener("compositionstart", () => {
      historyGeneration++;
      historyStatus.hidden = true;
      composerPort.setComposing(true);
      composerPort.syncQueueButton();
    });
    $("#prompt").addEventListener("compositionend", () => {
      composerPort.setComposing(false);
      handlePromptInput();
    });
    $("#prompt").addEventListener("blur", () => {
      composerPort.setComposing(false);
      composerPort.syncQueueButton();
    });
    $("#composerProjectButton").onclick = /** @param {Parameters<typeof workspacePort.openFolderPicker>} args */ (
      ...args
    ) => workspacePort.openFolderPicker(...args);
  }
  return { bind };
}
