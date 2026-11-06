import { localizeAttribute, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { closestElement, findElement, requireElement } from "./../dom.js";
import { attachmentDisplayUrl } from "../../shared/attachment-urls.js";
import {
  closeAsyncQuestionCard,
  closeEarlierAsyncQuestions,
  createAsyncQuestionCard,
  readAsyncQuestions,
} from "../async-questions.js";
import { codexIcon } from "../codex-icons.js";
import { attachmentsFromInput, composerInputKey, composerTextFromInput } from "../composer-attachments.js";
import { agentMessageText, renderAssistantMarkdown, renderItemImages } from "../rendering.js";
import { isAsyncQuestionReply } from "../../shared/engine/async-questions.js";
// Projects native items into the timeline and delegates identity, activity and review details.
/** @param {import("./ports.js").FeatureOptions<"viewUpdates" | "mutations" | "$" | "state" | "t" | "escapeHtml", "turnFrames" | "identity" | "sideTasks" | "viewport" | "activity" | "submission" | "queue" | "timing" | "clipboard" | "review", "messages">} options */
export function assembleMessages({
  turnFramesPort,
  viewUpdates,
  mutations,
  $,
  state,
  t,
  escapeHtml,
  identityPort,
  sideTasksPort,
  viewportPort,
  activityPort,
  submissionPort,
  queuePort,
  timingPort,
  clipboardPort,
  reviewPort,
}) {
  function upsertItem(item, turnId, root = $("#conversation"), live = true) {
    findElement("#emptyState", root)?.remove();
    let el = state.items.get(item.id) || null;
    if (el && !root.contains(el)) {
      mutations.collection("items").delete(item.id);
      el = null;
    }
    const followSubmission = live && !el && item.type === "userMessage" && String(item.id).startsWith("local-");
    if (!el && item.type === "userMessage")
      el =
        identityPort.claimOptimisticUser(item, root, turnId) ||
        identityPort.claimEquivalentUserMessage(item, root, turnId);
    // History hydration and aliases of an existing prompt are not new answers.
    if (!el && live && isAsyncQuestionReply(item)) {
      closeEarlierAsyncQuestions(root, t);
      viewUpdates.request("sessionWorkspace");
    }
    const questions = readAsyncQuestions(item);
    if (!el && questions && item.questionSourceId) {
      const alias = state.items.get(item.questionSourceId);
      if (alias?.matches("[data-async-question-card]") && root.contains(alias)) {
        el = alias;
        el.dataset.itemId = String(item.id);
        mutations.collection("items").set(item.id, el);
      }
    }
    if (!el && item.type === "agentMessage" && !questions) el = identityPort.claimEquivalentAgentMessage(item, turnId);
    if (questions) {
      // Structured questions may arrive after the initial text-only item.
      if (el && !el.matches("[data-async-question-card]")) {
        el.remove();
        mutations.collection("items").delete(item.id);
        el = null;
      }
      if (!el) {
        // Arguments can arrive after the generic tool row; replace that row once.
        const oldRow = findElement(
          `[data-item-id="${CSS.escape(activityPort.activityItemId(item))}"].activity-item`,
          root,
        );
        if (oldRow) {
          const group = closestElement("[data-agent-activity-group]", oldRow);
          oldRow.nextElementSibling?.remove();
          oldRow.remove();
          mutations.edit("activityItems", (draft) => draft.get(turnId)?.delete(activityPort.activityItemId(item)));
          if (findElement(".activity-item", group)) activityPort.updateActivitySummary(group);
          else group?.remove();
        }
        const questionThreadId = state.active?.id;
        el = createAsyncQuestionCard(item, questions, {
          t,
          onChange: () => viewUpdates.request("sessionWorkspace"),
          sendAnswer: (answer) =>
            submissionPort.submitPrompt({ preventDefault() {} }, { text: answer, threadId: questionThreadId || "" }),
        });
        requireElement(".turn-event-stream", turnFramesPort.ensureTurnTimeline(turnId, root)).append(el);
        mutations.collection("items").set(item.id, el);
      }
      if (item.questionState === "earlier") closeAsyncQuestionCard(el, t);
      timingPort.syncWorkedForDivider(turnId);
      viewUpdates.request("sessionWorkspace");
      return;
    }
    if (!el) {
      if (item.type === "userMessage") {
        el = document.createElement("article");
        el.className = "turn user-turn";
        el.dataset.userTurnId = turnId;
        if (String(item.id).startsWith("local-")) el.dataset.optimisticUser = "true";
        setMessageHtml(el, '<div class="user-message"></div>');
        const steer =
          item.steer ?? Boolean(findElement(`.user-turn[data-user-turn-id="${CSS.escape(String(turnId))}"]`, root));
        if (steer) {
          el.dataset.steer = "true";
          requireElement(".turn-event-stream", turnFramesPort.ensureTurnTimeline(turnId, root)).append(el);
        } else {
          const timeline = state.turns.get(turnId);
          timeline?.isConnected ? root.insertBefore(el, timeline) : root.append(el);
        }
      } else if (item.type === "agentMessage") {
        const timeline = turnFramesPort.ensureTurnTimeline(turnId, root);
        el = document.createElement("div");
        setMessageHtml(el, '<div class="message-text"></div>');
        identityPort.placeAgentMessage(el, item, timeline);
      } else if (item.type === "imageGeneration") {
        const timeline = turnFramesPort.ensureTurnTimeline(turnId, root);
        el = document.createElement("div");
        el.className = "assistant-generated-image";
        requireElement(".turn-event-stream", timeline).append(el);
      } else if (
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
          "collabAgentToolCall",
          "subAgentActivity",
          "webSearch",
          "reasoning",
          "plan",
          "imageView",
        ].includes(item.type)
      ) {
        const id = activityPort.activityItemId(item);
        el = activityPort.ensureActivity(turnId, root, id, item.type === "imageView" || item.type === "reasoning");
        activityPort.addActivity(item, el, id);
      } else return;
      if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "imageGeneration")
        mutations.collection("items").set(item.id, el);
    }
    if (!el) return;
    if (item.type === "userMessage") {
      queuePort.settleQueuedMessage(item, turnId);
      el.dataset.userTurnId = turnId;
      el.dataset.inputKey = composerInputKey(item.content);
      if (item.clientId) el.dataset.clientId = item.clientId;
      const userTimeline = state.turns.get(turnId),
        userTiming = state.turnTimings.get(turnId),
        userTimestamp =
          item.sentAt ??
          item.createdAt ??
          item.createdAtMs ??
          userTimeline?.dataset.turnStartedAt ??
          userTiming?.started ??
          el.dataset.messageTimestamp ??
          Date.now() / 1000;
      el.dataset.messageTimestamp = String(timingPort.timestampSeconds(userTimestamp) || Date.now() / 1000);
      timingPort.setMessageTime(el, el.dataset.messageTimestamp, "Sent at {time}");
      setOpaqueText(findElement(".user-message", el), composerTextFromInput(item.content));
      let copyButton = findElement("button.user-message-copy", el);
      if (!copyButton) {
        copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "user-message-copy";
        localizeAttribute(copyButton, "aria-label", "common.copyMessage", undefined);
        localizeAttribute(copyButton, "title", "common.copyMessage", undefined);
        setMessageHtml(copyButton, `${codexIcon("copy")}<span><span data-pf-message="files.copy">Copy</span></span>`);
        const copyTarget = copyButton;
        copyButton.onclick = () => clipboardPort.copyUserMessage(copyTarget);
        el.append(copyButton);
      }
      copyButton.hidden = !requireElement(".user-message", el).textContent;
      const files = attachmentsFromInput(item.content).filter((attachment) => attachment.kind === "file");
      let fileList = findElement(".user-message-files", el);
      el.classList.toggle("has-files", Boolean(files.length));
      if (files.length) {
        if (!fileList) {
          fileList = document.createElement("div");
          fileList.className = "user-message-files";
          requireElement(".user-message", el).after(fileList);
        }
        fileList.replaceChildren();
        for (const file of files) {
          const link = document.createElement("a");
          if (file.url) {
            link.href = attachmentDisplayUrl(file.url);
            link.target = "_blank";
            link.rel = "noopener noreferrer";
          } else {
            link.href = "#file-reference";
            link.dataset.fileReference = file.path;
            link.dataset.fileCwd = identityPort.imageCwd(item);
          }
          setOpaqueText(link, file.name);
          fileList.append(link);
        }
      } else fileList?.remove();
      let images = findElement(".user-message-images", el);
      const imageHtml = renderItemImages(item, { cwd: identityPort.imageCwd(item), className: "message-image-grid" });
      el.classList.toggle("has-images", Boolean(imageHtml));
      if (imageHtml) {
        if (!images) {
          images = document.createElement("div");
          images.className = "user-message-images";
          requireElement(".user-message", el).after(images);
        }
        setMessageHtml(images, imageHtml);
      } else images?.remove();
      if (item.steer || item.delivery || el.dataset.delivery || el.dataset.steer === "true") {
        if (item.steer) el.dataset.steer = "true";
        el.dataset.delivery =
          item.delivery || (el.dataset.optimisticUser === "true" ? el.dataset.delivery || "sending" : "sent");
        let status = findElement(".steer-message-status", el);
        if (!status) {
          status = document.createElement("div");
          status.className = "steer-message-status";
          status.setAttribute("role", "status");
          el.prepend(status);
        }
        const label =
          el.dataset.delivery === "sending"
            ? "common.sending"
            : el.dataset.delivery === "failed"
              ? "common.sendFailed"
              : el.dataset.delivery === "unconfirmed"
                ? "workbench.deliveryUnconfirmed"
                : "common.sent";
        setMessageHtml(
          status,
          (el.dataset.steer === "true"
            ? `<span>${messageHtml("sessions.steer", undefined, t)}</span><span aria-hidden="true"> · </span>`
            : "") + `<span>${messageHtml(label, undefined, t)}</span>`,
        );
      }
    }
    if (item.type === "agentMessage") {
      const timeline = turnFramesPort.ensureTurnTimeline(turnId, root),
        body = requireElement(".message-text", el),
        text = agentMessageText(item, body.dataset.raw ?? ""),
        cwd = identityPort.imageCwd(item),
        receivedTimestamp =
          item.receivedAt ??
          item.completedAt ??
          (item.phase === "final_answer" ? timeline.dataset.turnCompletedAt : null) ??
          el.dataset.messageTimestamp ??
          Date.now() / 1000;
      el.dataset.messageTimestamp = String(timingPort.timestampSeconds(receivedTimestamp) || Date.now() / 1000);
      timingPort.setMessageTime(el, el.dataset.messageTimestamp, "Received at {time}");
      identityPort.placeAgentMessage(el, item, timeline);
      body.dataset.raw = text;
      setMessageHtml(
        body,
        renderAssistantMarkdown(text, { cwd }) +
          renderItemImages(item, { cwd, className: "message-image-grid structured-message-images", excludeText: text }),
      );
      timingPort.syncWorkedForDivider(turnId);
    }
    if (item.type === "imageGeneration") {
      const html = renderItemImages(item, {
        cwd: identityPort.imageCwd(item),
        className: "generated-image-grid",
        thumbnail: true,
      });
      setMessageHtml(
        el,
        html ||
          `<div class="generated-image-pending ${item.status === "inProgress" ? "loading-shimmer" : ""}">${item.status === "failed" ? "Image generation failed" : "Generating image"}</div>`,
      );
    }
    if (item.type === "fileChange") {
      for (const ch of item.changes || []) {
        const path = ch.path || ch.filePath || "Changed file";
        mutations.collection("changes").set(path, ch);
      }
      reviewPort.syncTurnReviewFromItems(turnId);
      viewUpdates.request("review");
    }
    if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") sideTasksPort.updateSideTasks(item);
    if (live) viewportPort.scrollBottom({ force: followSubmission });
  }
  return {
    upsertItem,
  };
}
