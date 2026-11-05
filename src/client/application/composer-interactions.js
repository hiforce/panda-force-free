/** @param {import("./ports.js").FeatureOptions<"mutations" | "state" | "$", "composer" | "suggestions" | "uploads" | "queue" | "submission" | "workspace", "composerInteractions">} options */
export function assembleComposerInteractions({
  mutations,
  state,
  $,
  composerPort,
  suggestionsPort,
  uploadsPort,
  queuePort,
  submissionPort,
  workspacePort,
}) {
  function handlePromptInput(event) {
    composerPort.persistComposerDraft();
    composerPort.resizePrompt();
    if (!composerPort.promptComposing && !event?.isComposing) suggestionsPort.updateComposerAutocomplete();
  }
  function handlePromptKeydown(event) {
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
        input.value = entry.text;
        input.setSelectionRange(entry.text.length, entry.text.length);
        mutations.set("composerMentions", entry.mentions || []);
        mutations.set("composerAttachments", entry.attachments || []);
        uploadsPort.renderComposerAttachments();
        suggestionsPort.closeComposerAutocomplete();
        suggestionsPort.renderContextTray();
        composerPort.resizePrompt();
        return;
      }
    }
    if (event.key === "Tab" && !event.shiftKey && ($("#prompt").value.trim() || state.composerAttachments.length)) {
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
