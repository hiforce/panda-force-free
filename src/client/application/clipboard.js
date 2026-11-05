import { codexIcon } from "../codex-icons.js";

// Owns clipboard formatting and file-reference copy behavior.
export function assembleClipboard({ t, noticesPort }) {
  async function copyMessageText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {}
    }
    // LAN HTTP pages may not expose the Clipboard API.
    const active = document.activeElement,
      selection = document.getSelection(),
      ranges = [];
    if (selection)
      for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index).cloneRange());
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.append(field);
    try {
      field.select();
      if (!document.execCommand("copy")) throw new Error("Copy failed");
    } finally {
      field.remove();
      if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
  async function copyUserMessage(button) {
    const text = button.closest(".user-turn")?.querySelector(".user-message")?.textContent;
    if (!text || button.copyPending) return;
    button.copyPending = true;
    button.setAttribute("aria-busy", "true");
    clearTimeout(button.copyResetTimer);
    try {
      await copyMessageText(text);
      button.innerHTML = `${codexIcon("check")}<span>Copied</span>`;
      button.setAttribute("aria-label", "Copied");
      button.title = "Copied";
      noticesPort.toast(t("Copied"));
      button.copyResetTimer = setTimeout(() => {
        button.innerHTML = `${codexIcon("copy")}<span>Copy</span>`;
        button.setAttribute("aria-label", "Copy message");
        button.title = "Copy message";
      }, 2000);
    } catch {
      noticesPort.addPersistentError(t("Copy failed. Please select and copy the message manually."));
    } finally {
      button.copyPending = false;
      button.removeAttribute("aria-busy");
    }
  }
  function fileReferenceCopyText(anchor) {
    const path = anchor?.dataset?.fileReference;
    if (!path) return "";
    const start = Number(anchor.dataset.fileLineStart) || null,
      end = Number(anchor.dataset.fileLineEnd) || null;
    const suffix = start == null ? "" : `:${start}${end == null ? "" : `-${end}`}`;
    const label = anchor.textContent?.trim() || path;
    return `${label} (${path}${suffix})`;
  }
  function fileReferenceClipboardUrl(anchor) {
    const path = anchor?.dataset?.fileReference;
    if (!path) return "";
    const start = Number(anchor.dataset.fileLineStart) || null,
      end = Number(anchor.dataset.fileLineEnd) || null;
    const suffix = start == null ? "" : `:${start}${end == null ? "" : `-${end}`}`;
    const normalized = String(path).replaceAll("\\", "/");
    const encoded = encodeURI(normalized).replaceAll("#", "%23").replaceAll("?", "%3F");
    return /^[A-Za-z]:\//.test(normalized) ? `file:///${encoded}${suffix}` : `file://${encoded}${suffix}`;
  }
  function copyConversationFileReferences(event) {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData || !selection.rangeCount) return;
    const range = selection.getRangeAt(0),
      start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement,
      end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    const root = start?.closest(".message-text");
    if (!root || root !== end?.closest(".message-text")) return;
    const fragment = range.cloneContents(),
      citations = [...(fragment.querySelectorAll?.("a[data-file-reference]") || [])];
    if (!citations.length) return;
    for (const citation of citations) {
      const text = document.createTextNode(fileReferenceCopyText(citation));
      citation.replaceWith(text);
    }
    const textHolder = document.createElement("div");
    textHolder.append(fragment);
    const htmlFragment = range.cloneContents(),
      htmlCitations = [...(htmlFragment.querySelectorAll?.("a[data-file-reference]") || [])];
    for (const citation of htmlCitations) {
      citation.setAttribute("href", fileReferenceClipboardUrl(citation));
      citation.removeAttribute("data-file-reference");
      citation.removeAttribute("data-file-cwd");
    }
    const htmlHolder = document.createElement("div");
    htmlHolder.append(htmlFragment);
    event.clipboardData.setData("text/plain", textHolder.textContent || "");
    event.clipboardData.setData("text/html", htmlHolder.innerHTML);
    event.preventDefault();
  }
  function bind() {
    document.addEventListener("copy", (...args) => copyConversationFileReferences(...args));
  }
  return {
    bind,
    copyUserMessage,
    copyMessageText,
  };
}
