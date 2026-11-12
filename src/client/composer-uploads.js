import { errorMessage } from "./../shared/errors.js";
import { request as fetch } from "./http-client.js";
import { localizeAttribute, localizeText, setMessageHtml, setOpaqueAttribute, setOpaqueText } from "./i18n.js";
import { attachmentDisplayUrl } from "../shared/attachment-urls.js";
import { codexIcon } from "./codex-icons.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, filesFromClipboard } from "./composer-attachments.js";
import { localImageUrl } from "./rendering.js";
// Clipboard, drop and file-picker input share one upload and rendering path.
// Upload identity belongs to its original draft, even if navigation happens first.
export function createComposerUploads({
  $,
  t,
  state,
  openImageViewer,
  addPersistentError,
  onChange,
  mutations,
  onAttachmentUpdated = (_id, _patch) => {},
}) {
  function completeAttachment(id, patch) {
    onAttachmentUpdated(id, patch);
    if (state.composerAttachments.some((entry) => entry.id === id))
      mutations.edit("composerAttachments", (draft) => {
        const entry = draft.find((attachment) => attachment.id === id);
        if (entry) Object.assign(entry, patch, { id });
      });
  }
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
        setMessageHtml(icon, codexIcon("file"));
        chip.append(icon);
      }
      const label = document.createElement("span");
      label.className = "composer-attachment-name";
      label.dataset.i18nIgnore = "";
      setOpaqueText(label, attachment.name);
      setOpaqueAttribute(label, "title", attachment.error ? t(attachment.error) : attachment.name);
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
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-attachment-remove";
      localizeAttribute(remove, "aria-label", "composer.removeAttachmentName", { name: attachment.name }, t);
      setMessageHtml(remove, codexIcon("x"));
      remove.onclick = () => {
        mutations.set(
          "composerAttachments",
          state.composerAttachments.filter((value) => value.id !== attachment.id),
        );
        renderComposerAttachments();
        $("#prompt").focus();
      };
      chip.append(remove);
      tray.append(chip);
    }
    onChange();
  }
  async function uploadComposerFiles(files) {
    // Capture the destination before an upload can outlive navigation to another draft.
    /** @type {Record<string, string>} */
    const destination = state.active?.cwd
      ? { cwd: state.active.cwd }
      : state.newSessionProjectId
        ? { projectId: state.newSessionProjectId }
        : { cwd: $("#projectPath").textContent.replace(/^~/, state.config.home) || state.config.defaultCwd };
    for (const file of Array.from(files || [])) {
      if (state.composerAttachments.length >= ATTACHMENT_MAX_COUNT) {
        addPersistentError(t("composer.youCanAttachUpTo10Files"));
        break;
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        addPersistentError(t("composer.eachAttachmentMustBe25MibOrSmaller"));
        continue;
      }
      if (!file.size) {
        addPersistentError(t("errors.cannotUploadAnEmptyFile"));
        continue;
      }
      const attachment = {
        id: crypto.randomUUID(),
        name: file.name,
        kind: "file",
        status: "uploading",
      };
      mutations.edit("composerAttachments", (draft) => draft.push(attachment));
      renderComposerAttachments();
      // Stable attachment identity updates its saved draft without changing another task.
      void (async () => {
        try {
          const query = new URLSearchParams({ name: file.name, ...destination });
          const response = await fetch(`/api/attachments?${query}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Upload failed");
          completeAttachment(attachment.id, result.attachment);
        } catch (error) {
          completeAttachment(attachment.id, { status: "failed", error: errorMessage(error) });
          if (state.composerAttachments.some((entry) => entry.id === attachment.id))
            addPersistentError(t(errorMessage(error)));
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
