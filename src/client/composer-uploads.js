import { codexIcon } from "./codex-icons.js";
import { localImageUrl } from "./rendering.js";
import { attachmentDisplayUrl } from "../shared/attachment-urls.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, filesFromClipboard } from "./composer-attachments.js";

// Clipboard, drop and file-picker input share one upload and rendering path.
// Upload identity belongs to its original draft, even if navigation happens first.
export function createComposerUploads({ $, t, state, openImageViewer, addPersistentError, onChange }) {
  function composerAttachmentsReady() {
    return state.composerAttachments.every((attachment) => attachment.status === "ready");
  }
  function renderComposerAttachments() {
    const tray = $("#composerAttachments");
    tray.replaceChildren();
    tray.hidden = !state.composerAttachments.length;
    for (const attachment of state.composerAttachments) {
      const chip = document.createElement("div");
      chip.className = "composer-attachment";
      chip.dataset.status = attachment.status;
      chip.dataset.attachmentId = attachment.id;
      if (attachment.kind === "image" && (attachment.path || attachment.url)) {
        const source = attachment.url ? attachmentDisplayUrl(attachment.url) : localImageUrl(attachment.path);
        const preview = document.createElement("button");
        preview.type = "button";
        preview.className = "composer-attachment-preview";
        preview.setAttribute("aria-label", attachment.name);
        preview.onclick = () => openImageViewer(source, attachment.name, attachment.url || attachment.path);
        const image = document.createElement("img");
        image.src = source;
        image.alt = attachment.name;
        preview.append(image);
        chip.append(preview);
      } else {
        const icon = document.createElement("span");
        icon.innerHTML = codexIcon("file");
        chip.append(icon);
      }
      const label = document.createElement("span");
      label.className = "composer-attachment-name";
      label.dataset.i18nIgnore = "";
      label.textContent = attachment.name;
      label.title = attachment.error ? t(attachment.error) : attachment.name;
      chip.append(label);
      if (attachment.status !== "ready") {
        const status = document.createElement("span");
        status.className = "composer-attachment-status";
        status.textContent = t(attachment.status === "uploading" ? "Uploading…" : "Upload failed");
        chip.append(status);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-attachment-remove";
      remove.setAttribute("aria-label", t("Remove attachment {name}", { name: attachment.name }));
      remove.innerHTML = codexIcon("x");
      remove.onclick = () => {
        state.composerAttachments = state.composerAttachments.filter((value) => value !== attachment);
        renderComposerAttachments();
        $("#prompt").focus();
      };
      chip.append(remove);
      tray.append(chip);
    }
    onChange();
  }
  async function uploadComposerFiles(files) {
    for (const file of Array.from(files || [])) {
      if (state.composerAttachments.length >= ATTACHMENT_MAX_COUNT) {
        addPersistentError(t("You can attach up to 10 files"));
        break;
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        addPersistentError(t("Each attachment must be 25 MiB or smaller"));
        continue;
      }
      if (!file.size) {
        addPersistentError(t("Cannot upload an empty file"));
        continue;
      }
      const attachment = {
        id: crypto.randomUUID(),
        name: file.name,
        kind: "file",
        status: "uploading",
      };
      state.composerAttachments.push(attachment);
      renderComposerAttachments();
      // Keep the same object in saved drafts; a late upload never enters another task.
      void (async () => {
        try {
          const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Upload failed");
          Object.assign(attachment, result.attachment);
        } catch (error) {
          attachment.status = "failed";
          attachment.error = error.message;
          if (state.composerAttachments.includes(attachment)) addPersistentError(t(error.message));
        }
        renderComposerAttachments();
      })();
    }
  }
  $("#composer").addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    $("#composer").classList.add("attachment-dragover");
  });
  $("#composer").addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !$("#composer").contains(event.relatedTarget))
      $("#composer").classList.remove("attachment-dragover");
  });
  $("#composer").addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    $("#composer").classList.remove("attachment-dragover");
    uploadComposerFiles(event.dataTransfer.files);
  });
  $("#prompt").addEventListener("paste", (event) => {
    const files = filesFromClipboard(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      uploadComposerFiles(files);
    }
  });
  return { composerAttachmentsReady, renderComposerAttachments, uploadComposerFiles };
}
