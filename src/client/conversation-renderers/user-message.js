import { localizeAttribute, messageHtml, setMessageHtml, setOpaqueText } from "../i18n.js";
import { findElement, requireElement } from "../dom.js";
import { attachmentDisplayUrl } from "../../shared/attachment-urls.js";
import { codexIcon } from "../codex-icons.js";
import { attachmentsFromInput, composerInputKey, composerTextFromInput } from "../composer-attachments.js";
import { renderItemImages } from "../rendering.js";

// Owns this element type; identity, transactions and lifecycle belong to the caller.
/** @param {Pick<import("./types.js").ConversationRendererServices, "state" | "turnFramesPort" | "queuePort" | "timingPort" | "identityPort" | "clipboardPort" | "t">} services */
export function createUserMessageRenderer({
  state,
  turnFramesPort,
  queuePort,
  timingPort,
  identityPort,
  clipboardPort,
  t,
}) {
  return {
    id: "user-message",
    types: ["userMessage"],
    /** @param {import("./types.js").ConversationRenderContext} context */
    render({ item, turnId, root, element }) {
      let el = element;
      if (!el) {
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
      }
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

      return el;
    },
  };
}
