import type { ComposerAttachment } from "../shared/data-contracts.js";
import type { Translate } from "../shared/i18n/messages.js";
import { codexIcon } from "./codex-icons.js";
import { localizeAttribute, localizeText, setMessageHtml, setOpaqueText } from "./i18n.js";
import { isMessageId } from "../shared/i18n/message-id.js";

/** All composers render the same attachment cards; their owning draft controls upload and removal. */
export function renderComposerAttachmentTray(options: {
  host: HTMLElement;
  attachments: readonly ComposerAttachment[];
  t: Translate;
  source(attachment: ComposerAttachment): string;
  preview?(source: string, attachment: ComposerAttachment): void;
  remove(id: string): void;
  retry?(id: string): void;
}) {
  const { host, attachments, t } = options;
  host.replaceChildren();
  host.hidden = !attachments.length;
  for (const attachment of attachments) {
    const chip = document.createElement("div");
    chip.className = "composer-attachment";
    chip.dataset.status = attachment.status;
    chip.dataset.attachmentId = attachment.id;
    const source = options.source(attachment);
    if (attachment.kind === "image" && source) {
      const preview = document.createElement("button"),
        image = document.createElement("img");
      preview.type = "button";
      preview.className = "composer-attachment-preview";
      preview.setAttribute("aria-label", attachment.name);
      image.src = source;
      image.alt = attachment.name;
      preview.append(image);
      preview.onclick = () => options.preview?.(source, attachment);
      chip.append(preview);
    } else {
      const icon = document.createElement("span");
      setMessageHtml(icon, codexIcon("file"));
      chip.append(icon);
    }
    const label = document.createElement("span");
    label.className = "composer-attachment-name";
    label.dataset.i18nIgnore = "";
    setOpaqueText(label, attachment.name);
    label.title = attachment.error && isMessageId(attachment.error) ? t(attachment.error) : attachment.name;
    chip.append(label);
    if (attachment.status !== "ready") {
      const status = document.createElement("span");
      status.className = "composer-attachment-status";
      localizeText(
        status,
        attachment.status === "uploading" ? "common.uploading" : "common.uploadFailed",
        undefined,
        t,
      );
      chip.append(status);
    }
    if (attachment.status === "failed" && options.retry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "composer-attachment-remove";
      localizeAttribute(retry, "aria-label", "common.retry", undefined, t);
      setMessageHtml(retry, codexIcon("refreshCw"));
      retry.onclick = () => options.retry?.(attachment.id);
      chip.append(retry);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-attachment-remove";
    localizeAttribute(remove, "aria-label", "composer.removeAttachmentName", { name: attachment.name }, t);
    setMessageHtml(remove, codexIcon("x"));
    remove.onclick = () => options.remove(attachment.id);
    chip.append(remove);
    host.append(chip);
  }
}
