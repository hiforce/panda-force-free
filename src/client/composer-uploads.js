import { errorText } from "./i18n.js";
import { errorMessage } from "./../shared/errors.js";
import { request as fetch } from "./http-client.js";
import { renderComposerAttachmentTray } from "./composer-attachment-view.js";
import { attachmentDisplayUrl } from "../shared/attachment-urls.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, filesFromClipboard } from "./composer-attachments.js";
import { localImageUrl } from "./rendering.js";
import { creationSessionRoute } from "./creation/session-route.js";
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
    renderComposerAttachmentTray({
      host: $("#composerAttachments"),
      attachments: state.composerAttachments,
      t,
      source: (attachment) =>
        attachment.url ? attachmentDisplayUrl(attachment.url) : attachment.path ? localImageUrl(attachment.path) : "",
      preview: (source, attachment) => openImageViewer(source, attachment.name, attachment.url || attachment.path),
      remove: (id) => {
        mutations.set(
          "composerAttachments",
          state.composerAttachments.filter((value) => value.id !== id),
        );
        renderComposerAttachments();
        $("#prompt").focus();
      },
    });
    onChange();
  }
  function uploadComposerSource(name, load) {
    const creation = Boolean(creationSessionRoute());
    // Capture the destination before an upload can outlive navigation to another draft.
    /** @type {Record<string, string>} */
    const destination = state.active?.cwd
      ? { cwd: state.active.cwd }
      : state.newSessionProjectId
        ? { projectId: state.newSessionProjectId }
        : { cwd: $("#projectPath").textContent.replace(/^~/, state.config.home) || state.config.defaultCwd };
    if (state.composerAttachments.length >= ATTACHMENT_MAX_COUNT) {
      addPersistentError(t("composer.youCanAttachUpTo10Files"));
      return;
    }
    const attachment = {
      id: crypto.randomUUID(),
      name,
      kind: "file",
      status: "uploading",
    };
    mutations.edit("composerAttachments", (draft) => draft.push(attachment));
    renderComposerAttachments();
    // Stable attachment identity updates its saved draft without changing another task.
    void (async () => {
      try {
        const file = await load();
        if (file.size > ATTACHMENT_MAX_BYTES) throw new Error("composer.eachAttachmentMustBe25MibOrSmaller");
        if (!file.size) throw new Error("errors.cannotUploadAnEmptyFile");
        const query = new URLSearchParams({ name: file.name, ...(creation ? {} : destination) });
        const response = await fetch(`${creation ? "/api/creation-materials" : "/api/attachments"}?${query}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(creation ? errorText(result, t, "creation.unavailable") : result.error || "Upload failed");
        completeAttachment(attachment.id, result.attachment);
      } catch (error) {
        completeAttachment(attachment.id, { status: "failed", error: errorMessage(error) });
        if (state.composerAttachments.some((entry) => entry.id === attachment.id))
          addPersistentError(t(errorMessage(error)));
      }
      renderComposerAttachments();
    })();
  }
  function uploadComposerFiles(files) {
    for (const file of Array.from(files || [])) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        addPersistentError(t("composer.eachAttachmentMustBe25MibOrSmaller"));
        continue;
      }
      if (!file.size) {
        addPersistentError(t("errors.cannotUploadAnEmptyFile"));
        continue;
      }
      if (state.composerAttachments.length >= ATTACHMENT_MAX_COUNT) {
        addPersistentError(t("composer.youCanAttachUpTo10Files"));
        break;
      }
      uploadComposerSource(file.name, () => Promise.resolve(file));
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
  return { composerAttachmentsReady, renderComposerAttachments, uploadComposerFiles, uploadComposerSource };
}
