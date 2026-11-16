import { copyPlainText as copyMessageText } from "../clipboard-text.js";
import { localizeAttribute, setMessageHtml } from "../i18n.js";
import { closestElement, findElement, findElements } from "./../dom.js";

import { codexIcon } from "../codex-icons.js";

// Owns clipboard formatting and file-reference copy behavior.
/** @param {import("./ports.js").FeatureOptions<"t", "notices", "clipboard">} options */
export function assembleClipboard({ t, noticesPort }) {
  async function copyUserMessage(button) {
    const text = findElement(".user-message", closestElement(".user-turn", button))?.textContent;
    if (!text || button.copyPending) return;
    button.copyPending = true;
    button.setAttribute("aria-busy", "true");
    clearTimeout(button.copyResetTimer);
    try {
      await copyMessageText(text);
      setMessageHtml(button, `${codexIcon("check")}<span><span data-pf-message="common.copied">Copied</span></span>`);
      localizeAttribute(button, "aria-label", "common.copied", undefined);
      localizeAttribute(button, "title", "common.copied", undefined);
      noticesPort.toast(t("common.copied"));
      button.copyResetTimer = setTimeout(() => {
        setMessageHtml(button, `${codexIcon("copy")}<span><span data-pf-message="files.copy">Copy</span></span>`);
        localizeAttribute(button, "aria-label", "common.copyMessage", undefined);
        localizeAttribute(button, "title", "common.copyMessage", undefined);
      }, 2000);
    } catch {
      noticesPort.addPersistentError(t("workbench.copyFailedPleaseSelectAndCopyTheMessageManually"));
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
    const root = closestElement(".message-text", start);
    if (!root || root !== closestElement(".message-text", end)) return;
    const fragment = range.cloneContents(),
      citations = [...(findElements("a[data-file-reference]", fragment) || [])];
    if (!citations.length) return;
    for (const citation of citations) {
      const text = document.createTextNode(fileReferenceCopyText(citation));
      citation.replaceWith(text);
    }
    const textHolder = document.createElement("div");
    textHolder.append(fragment);
    const htmlFragment = range.cloneContents(),
      htmlCitations = [...(findElements("a[data-file-reference]", htmlFragment) || [])];
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
    document.addEventListener(
      "copy",
      /** @param {Parameters<typeof copyConversationFileReferences>} args */ (...args) =>
        copyConversationFileReferences(...args),
    );
  }
  return {
    bind,
    copyUserMessage,
    copyMessageText,
  };
}
