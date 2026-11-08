import { threadInputErrorMessage } from "../../shared/bridge-errors.js";
import { isTransportSwitch } from "../../shared/errors.js";
import { buildComposerInput } from "../composer-attachments.js";
import { errorCode, errorMessage } from "./../../shared/errors.js";
import { deliveryIsUncertain } from "./input-errors.js";
import { steerOrStart } from "./turn-input.js";

// Coordinates a single explicit input transaction while preserving draft and acknowledgement semantics.
/** @param {import("./ports.js").FeatureOptions<"selection" | "viewUpdates" | "mutations" | "state" | "t" | "$", "transport" | "delivery" | "suggestions" | "models" | "composer" | "commands" | "uploads" | "notices" | "synchronization" | "inputSessions", "submission">} options */
export function assembleSubmission({
  transportPort,
  selection,
  viewUpdates,
  mutations,
  state,
  t,
  $,
  deliveryPort,
  suggestionsPort,
  modelsPort,
  composerPort,
  commandsPort,
  uploadsPort,
  noticesPort,
  synchronizationPort,
  inputSessionsPort,
}) {
  /** @param {{preventDefault(): void}} event @param {{text: string; threadId: string} | null} questionAnswer */
  async function submitPrompt(event, questionAnswer = null) {
    event.preventDefault();
    const submissionKey = deliveryPort.pendingMessageOwner();
    if (questionAnswer && (!questionAnswer.threadId || questionAnswer.threadId !== state.active?.id))
      throw new Error(t("workbench.conversationChangedReopenTheQuestionBeforeSubmitting"));
    if (deliveryPort.isSending(submissionKey)) {
      if (questionAnswer) throw new Error(t("workbench.aMessageIsStillBeingSentPleaseWaitAndTry"));
      return;
    }
    suggestionsPort.closeComposerAutocomplete();
    modelsPort.closePermissionMenu();
    const input = $("#prompt"),
      text = questionAnswer ? questionAnswer.text.trim() : input.value.trim(),
      attachments = questionAnswer ? [] : [...state.composerAttachments],
      content = buildComposerInput(text, attachments),
      hasContent = content.length > 0,
      turnId = composerPort.activeTurnId();
    let thread = state.active;
    const goalCommand = !questionAnswer && !attachments.length ? commandsPort.parseGoalCommand(text) : null;
    if (goalCommand) {
      try {
        await commandsPort.submitGoalCommand(thread, goalCommand);
        if (thread?.id)
          composerPort.composerHistory.record({ text, mentions: state.composerMentions, attachments: [] });
      } catch (error) {
        noticesPort.addPersistentError(errorMessage(error));
      }
      return;
    }
    const nativeSlashCommand =
      !questionAnswer && !attachments.length ? commandsPort.parseNativeSlashCommand(text) : null;
    if (nativeSlashCommand) {
      try {
        await commandsPort.submitNativeSlashCommand(thread, nativeSlashCommand);
        input.value = "";
        viewUpdates.request("composerLayout");
      } catch (error) {
        noticesPort.addPersistentError(errorMessage(error));
      }
      return;
    }
    const localSlashCommand = !questionAnswer && !attachments.length ? commandsPort.parseLocalSlashCommand(text) : null;
    if (localSlashCommand) {
      commandsPort.handleLocalSlashCommand(localSlashCommand);
      input.value = "";
      viewUpdates.request("composerLayout");
      return;
    }
    const generation = selection.current;
    const isCurrent = () => generation === selection.current && state.active?.id === thread?.id;
    if ((!hasContent && !turnId) || (!questionAnswer && !uploadsPort.composerAttachmentsReady())) return;
    const submissionToken = Symbol();
    deliveryPort.lock(submissionKey, submissionToken);
    const mentions = questionAnswer ? [] : state.composerMentions,
      model = state.selectedModel,
      productProjectId = state.newSessionProjectId,
      effort = $("#effortSelect").value;
    let cwd = thread?.cwd || $("#projectPath").textContent.replace(/^~/, state.config.home);
    const threadPolicy = modelsPort.permissionThreadPolicy();
    let turnPolicy = modelsPort.permissionTurnPolicy(cwd);
    let optimisticId = null,
      sent = false,
      dispatchStarted = false,
      deliveryUncertain = false;
    try {
      if (turnId && !hasContent) {
        if (thread) await transportPort.rpc("turn/interrupt", { threadId: thread.id, turnId });
        return;
      }
      // Render before any network request, including creating or resuming a session.
      optimisticId = deliveryPort.nextMessageId("local");
      const optimistic = {
        id: optimisticId,
        type: "userMessage",
        content,
        owner: submissionKey,
        submissionToken,
        turnId: turnId || "optimistic",
        steer: Boolean(turnId),
        delivery: "sending",
        excludedTurns: [...(thread?.turns || []).map((turn) => turn.id), ...state.turns.keys()].filter(
          (id) => id !== turnId,
        ),
      };
      deliveryPort.track(optimistic);
      viewUpdates.request("item", { item: optimistic, turnId: optimistic.turnId });
      composerPort.composerHistory.record({ text, mentions, attachments });
      if (!questionAnswer) {
        input.value = "";
        mutations.set("composerMentions", []);
        mutations.set("composerAttachments", []);
        uploadsPort.renderComposerAttachments();
        suggestionsPort.renderContextTray();
        viewUpdates.request("composerLayout");
      }
      if (turnId && thread) {
        const currentThread = thread;
        const result = await steerOrStart({
          rpc: /** @param {Parameters<typeof transportPort.rpc>} args */ (...args) => transportPort.rpc(...args),
          resume: /** @param {Parameters<typeof inputSessionsPort.resumeActiveThread>} args */ (...args) =>
            inputSessionsPort.resumeActiveThread(...args),
          thread,
          turnId,
          input: content,
          clientUserMessageId: attachments.length ? optimisticId : null,
          startOptions: { model, effort, cwd, ...turnPolicy },
          onDispatch: (value) => {
            dispatchStarted = value;
          },
          onNoActiveTurn: () => {
            if (state.active?.id === currentThread.id && composerPort.activeTurnId() === turnId)
              composerPort.setActiveTurnId("");
            optimistic.turnId = "optimistic";
            optimistic.steer = false;
            optimistic.excludedTurns.push(turnId);
            const node = state.active?.id === currentThread.id ? state.items.get(optimisticId) : null;
            if (node) {
              delete node.dataset.steer;
              node.dataset.userTurnId = "optimistic";
              $("#conversation").append(node);
            }
          },
        });
        if (result?.turn?.id) optimistic.turnId = result.turn.id;
        sent = true;
        deliveryPort.setPendingMessageDelivery(optimisticId, "sent");
        if (!questionAnswer) composerPort.clearComposerDraft(thread.id);
        modelsPort.commitSessionModelSettings(thread.id);
        if (isCurrent()) synchronizationPort.scheduleActiveThreadSync(0);
        return { sent: true };
      }
      thread = await inputSessionsPort.prepareInputSession({
        thread,
        cwd,
        model,
        policy: threadPolicy,
        projectId: productProjectId,
        generation,
        pending: optimistic,
        token: submissionToken,
        resumeExisting: false,
        onCreated: (created) => {
          thread = created;
        },
      });
      dispatchStarted = true;
      cwd = thread.cwd || cwd;
      turnPolicy = modelsPort.permissionTurnPolicy(cwd);
      const result = await transportPort.rpc("turn/start", {
        threadId: thread.id,
        ...(thread.canAcceptDirectInput !== true ? { pandaPrepareInput: true } : {}),
        input: content,
        ...(attachments.length ? { clientUserMessageId: optimisticId } : {}),
        model,
        effort,
        cwd,
        ...turnPolicy,
      });
      if (result?.turn?.id) optimistic.turnId = result.turn.id;
      sent = true;
      deliveryPort.setPendingMessageDelivery(optimisticId, "sent");
      if (!questionAnswer) composerPort.clearComposerDraft(thread.id);
      modelsPort.commitSessionModelSettings(thread.id);
      return { sent: true };
    } catch (error) {
      // An echoed item is stronger evidence than a lost acknowledgement.
      if (optimisticId && !deliveryPort.hasMessage(optimisticId)) {
        sent = true;
        return { sent: true };
      }
      const uncertain = deliveryIsUncertain(error, dispatchStarted);
      deliveryUncertain = uncertain;
      deliveryPort.setPendingMessageDelivery(optimisticId || "", uncertain ? "unconfirmed" : "failed");
      if (isCurrent()) {
        if (!questionAnswer && !uncertain && !input.value && !state.composerAttachments.length) {
          input.value = text;
          mutations.set("composerMentions", mentions);
          mutations.set("composerAttachments", attachments);
          uploadsPort.renderComposerAttachments();
          suggestionsPort.renderContextTray();
          viewUpdates.request("composerLayout");
        }
        if (!isTransportSwitch(error))
          noticesPort.addPersistentError(
            uncertain
              ? t("workbench.deliveryUnconfirmed")
              : errorCode(error) === "bridge_network_error"
                ? t("errors.messageNotSentConnectionInterrupted")
                : threadInputErrorMessage(error),
          );
      }
      if (questionAnswer) {
        if (uncertain) return { deliveryUncertain: true };
        throw error;
      }
    } finally {
      deliveryPort.releasePromptSubmission(submissionToken);
      if (optimisticId && !sent && !dispatchStarted) deliveryPort.setPendingMessageDelivery(optimisticId, "failed");
      if (
        !questionAnswer &&
        hasContent &&
        !sent &&
        !deliveryUncertain &&
        !isCurrent() &&
        thread?.id &&
        !composerPort.getComposerDraft(thread.id)?.text &&
        !composerPort.getComposerDraft(thread.id)?.attachments?.length
      ) {
        composerPort.setComposerDraft(thread.id, { text, mentions, attachments });
        if (state.active?.id === thread.id && !input.value) {
          composerPort.restoreComposerDraft();
          suggestionsPort.renderContextTray();
        }
      }
    }
  }
  return {
    submitPrompt,
  };
}
