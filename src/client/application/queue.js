import { localizeText, setOpaqueText } from "../i18n.js";

import { deliveryIsUncertain } from "./input-errors.js";
import {
  buildComposerInput,
  attachmentsFromInput,
  composerTextFromInput,
  composerInputKey,
} from "../composer-attachments.js";

// Owns queued input, reconciliation versions, cancellation and uncertain acknowledgements.
export function assembleQueue({
  transportPort,
  selection,
  viewUpdates,
  mutations,
  $,
  t,
  state,
  deliveryPort,
  noticesPort,
  uploadsPort,
  composerPort,
  modelsPort,
  suggestionsPort,
  inputSessionsPort,
}) {
  const queuedMessages = new Map();
  const settledQueueMessages = new Set();
  const queueReadVersions = new Map();
  function renderMessageQueue() {
    const root = $("#messageQueue");
    if (!root) return;
    const messages = [...queuedMessages.values()].filter(
      (message) => message.owner === deliveryPort.pendingMessageOwner(),
    );
    root.hidden = !messages.length;
    root.replaceChildren();
    for (const message of messages) {
      const row = document.createElement("div");
      row.className = "message-queue-row";
      row.dataset.status = message.status;
      row.dataset.clientId = message.clientId;
      const body = document.createElement("span");
      body.className = "message-queue-text";
      body.dataset.i18nIgnore = "";
      setOpaqueText(
        body,
        [message.text, message.attachments?.map((attachment) => attachment.name).join(", ")]
          .filter(Boolean)
          .join(" · ") || t("common.image"),
      );
      const status = document.createElement("span");
      status.className = "message-queue-status";
      localizeText(
        status,
        {
          sending: "common.queueing",
          queued: "common.queued",
          starting: "common.startingMessage",
          failed: "composer.queueFailed",
          unconfirmed: "common.queueUnconfirmed",
          cancelling: "common.cancelling",
        }[message.status],
        undefined,
        t,
      );
      row.append(body, status);
      if ((message.status === "queued" && message.queueId) || message.status === "failed") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "message-queue-cancel";
        localizeText(
          button,
          message.status === "failed" ? "common.dismissingMessage" : "common.cancelQueuedMessage",
          undefined,
          t,
        );
        button.onclick = () => cancelQueuedMessage(message);
        row.append(button);
      }
      root.append(row);
    }
  }
  function settleQueuedMessage(item, turnId, threadId = state.active?.id) {
    if (String(item.id).startsWith("local-")) return;
    if (item.clientId) settledQueueMessages.add(item.clientId);
    const message = item.clientId
      ? queuedMessages.get(item.clientId)
      : [...queuedMessages.values()].find(
          (message) =>
            message.owner === threadId &&
            message.status === "starting" &&
            !message.excludedTurns.has(turnId) &&
            composerInputKey(message.content || [{ type: "text", text: message.text }]) ===
              composerInputKey(item.content),
        );
    if (message?.owner !== threadId) return;
    if (!message) return;
    settledQueueMessages.add(message.clientId);
    queuedMessages.delete(message.clientId);
    deliveryPort.releasePromptSubmission(message.submissionToken);
    renderMessageQueue();
  }
  async function refreshMessageQueue(threadId = state.active?.id) {
    if (!threadId) return;
    const version = (queueReadVersions.get(threadId) || 0) + 1;
    queueReadVersions.set(threadId, version);
    try {
      const data = [];
      let cursor;
      do {
        const result = await transportPort.rpc("thread/queue/list", {
          threadId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (queueReadVersions.get(threadId) !== version) return;
        data.push(...(result.data || []));
        cursor = result.nextCursor;
      } while (cursor);
      const present = new Set();
      for (const entry of data) {
        const clientId = entry.clientUserMessageId;
        if (settledQueueMessages.has(clientId)) continue;
        present.add(clientId);
        const existing = queuedMessages.get(clientId);
        if (existing) {
          existing.queueId = entry.id;
          if (existing.status !== "cancelling") existing.status = "queued";
          deliveryPort.releasePromptSubmission(existing.submissionToken);
        } else {
          const thread = state.threads.find((thread) => thread.id === threadId);
          queuedMessages.set(clientId, {
            clientId,
            owner: threadId,
            queueId: entry.id,
            text: composerTextFromInput(entry.input),
            content: entry.input,
            attachments: attachmentsFromInput(entry.input),
            status: "queued",
            excludedTurns: new Set((thread?.turns || []).map((turn) => turn.id)),
          });
        }
      }
      for (const message of queuedMessages.values())
        if (message.owner === threadId && message.status === "queued" && !present.has(message.clientId))
          message.status = "starting";
      renderMessageQueue();
    } catch {
      /* Keep acknowledged and pending messages visible while offline. */
    }
  }
  async function cancelQueuedMessage(message) {
    if (message.status === "failed") {
      queuedMessages.delete(message.clientId);
      renderMessageQueue();
      return;
    }
    if (message.status !== "queued" || !message.queueId) return;
    message.status = "cancelling";
    renderMessageQueue();
    try {
      await transportPort.rpc("thread/queue/delete", { threadId: message.owner, queuedSubmissionId: message.queueId });
      settledQueueMessages.add(message.clientId);
      queuedMessages.delete(message.clientId);
    } catch (error) {
      if (queuedMessages.has(message.clientId)) message.status = "queued";
      noticesPort.addPersistentError(error.message);
    }
    renderMessageQueue();
    refreshMessageQueue(message.owner);
  }
  async function queuePrompt() {
    const input = $("#prompt"),
      text = input.value.trim(),
      attachments = [...state.composerAttachments],
      content = buildComposerInput(text, attachments),
      owner = deliveryPort.pendingMessageOwner();
    if (
      (!text && !attachments.length) ||
      !uploadsPort.composerAttachmentsReady() ||
      composerPort.promptComposing ||
      deliveryPort.isSending(owner)
    )
      return;
    const generation = selection.current,
      token = Symbol(),
      clientId = deliveryPort.nextMessageId("queue");
    let thread = state.active,
      dispatchStarted = false;
    const current = () => generation === selection.current && state.active?.id === thread?.id;
    const message = {
      clientId,
      owner,
      text,
      content,
      attachments,
      status: "sending",
      submissionToken: token,
      excludedTurns: new Set(
        [...(thread?.turns || []).map((turn) => turn.id), ...state.turns.keys(), composerPort.activeTurnId()].filter(
          Boolean,
        ),
      ),
    };
    const mentions = state.composerMentions,
      model = state.selectedModel,
      productProjectId = state.newSessionProjectId,
      cwd = thread?.cwd || $("#projectPath").textContent.replace(/^~/, state.config.home),
      policy = modelsPort.permissionThreadPolicy();
    queuedMessages.set(clientId, message);
    deliveryPort.lock(owner, token);
    suggestionsPort.closeComposerAutocomplete();
    renderMessageQueue();
    composerPort.composerHistory.record({ text, mentions, attachments });
    input.value = "";
    mutations.set("composerMentions", []);
    mutations.set("composerAttachments", []);
    uploadsPort.renderComposerAttachments();
    suggestionsPort.renderContextTray();
    viewUpdates.request("composerLayout");
    try {
      thread = await inputSessionsPort.prepareInputSession({
        thread,
        cwd,
        model,
        policy: policy,
        projectId: productProjectId,
        generation,
        pending: message,
        token: token,
        onCreated: (created) => {
          thread = created;
        },
      });
      if (!current()) throw new Error(t("composer.queueFailed"));
      dispatchStarted = true;
      const result = await transportPort.rpc("thread/queue/add", {
        threadId: thread.id,
        clientUserMessageId: clientId,
        input: content,
      });
      if (queuedMessages.has(clientId)) {
        message.queueId = result.queuedSubmission.id;
        message.status = "queued";
        modelsPort.commitSessionModelSettings(thread.id);
      }
      refreshMessageQueue(thread.id);
    } catch (error) {
      if (!queuedMessages.has(clientId)) return;
      const uncertain = deliveryIsUncertain(error, dispatchStarted);
      // A queue snapshot can confirm an add even if its acknowledgement was lost.
      if (!message.queueId) message.status = uncertain ? "unconfirmed" : "failed";
      if (current() && !uncertain && !message.queueId && !input.value && !state.composerAttachments.length) {
        input.value = text;
        mutations.set("composerMentions", mentions);
        mutations.set("composerAttachments", attachments);
        uploadsPort.renderComposerAttachments();
        suggestionsPort.renderContextTray();
        viewUpdates.request("composerLayout");
      }
      if (current() && !message.queueId && !uncertain)
        noticesPort.addPersistentError(error?.message || t("composer.queueFailed"));
      if (dispatchStarted) refreshMessageQueue(thread.id);
    } finally {
      deliveryPort.releasePromptSubmission(token);
      if (
        message.status === "failed" &&
        !current() &&
        thread?.id &&
        !composerPort.getComposerDraft(thread.id)?.text &&
        !composerPort.getComposerDraft(thread.id)?.attachments?.length
      ) {
        composerPort.setComposerDraft(thread.id, { text, mentions, attachments });
        if (state.active?.id === thread.id && !input.value && !state.composerAttachments.length) {
          composerPort.restoreComposerDraft();
          suggestionsPort.renderContextTray();
        }
      }
      renderMessageQueue();
      viewUpdates.request("composerSubmit");
    }
  }
  function bind() {
    $("#queueButton").onclick = (...args) => queuePrompt(...args);
  }
  return {
    bind,
    renderMessageQueue,
    refreshMessageQueue,
    queuePrompt,
    settleQueuedMessage,
  };
}
