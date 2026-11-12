import { attachmentUrlName, canonicalAttachmentUrl } from "../shared/attachment-urls.js";
import { stripAttachmentWorkspaceContext } from "../shared/attachment-workspace.js";

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;

export function filesFromClipboard(clipboardData, { now = () => new Date() } = {}) {
  let files = Array.from(clipboardData?.files || []);
  // Read getAsFile synchronously while the paste event still grants access.
  // Use one representation so browsers exposing both lists do not duplicate files.
  if (!files.length)
    files = Array.from(clipboardData?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
  return files.map((file, index) => {
    if (file.name?.trim()) return file;
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[file.type];
    const stamp = now().toISOString().replace(/[-:.]/g, "");
    const name = `clipboard-${stamp}-${index + 1}${extension ? `.${extension}` : ""}`;
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}

/** @param {string} text @param {readonly import("../shared/data-contracts.js").ComposerAttachment[]} attachments @returns {import("../shared/data-contracts.js").NativeInput[]} */
export function buildComposerInput(text, attachments = []) {
  /** @type {import("../shared/data-contracts.js").NativeInput[]} */
  const input = text ? [{ type: "text", text }] : [];
  for (const attachment of attachments) {
    if (!attachment.url && !attachment.path) throw new Error("Attachment has no readable location");
    if (attachment.kind === "image")
      input.push(
        attachment.url ? { type: "image", url: attachment.url } : { type: "localImage", path: attachment.path || "" },
      );
    else
      input.push({
        type: "text",
        text: `Attached file: ${JSON.stringify(attachment.name)}\n${attachment.url || attachment.path}`,
      });
  }
  return input;
}

/** @param {readonly {type: string; text?: string; path?: string; url?: string}[]} input @returns {import("../shared/data-contracts.js").ComposerAttachment[]} */
export function attachmentsFromInput(input = []) {
  return input.flatMap((part) => {
    if (part.type === "image" && /^https:\/\//i.test(part.url || "")) {
      const url = canonicalAttachmentUrl(part.url) || part.url || "";
      return [{ id: url, url, name: attachmentUrlName(url), kind: "image", status: "ready" }];
    }
    if (part.type === "localImage" && part.path)
      return [
        {
          id: part.path,
          path: part.path,
          name: part.path.split(/[\\/]/).at(-1) || "image",
          kind: "image",
          status: "ready",
        },
      ];
    if (part.type === "text") {
      const files = [];
      for (const match of (part.text || "").matchAll(/^Attached file: (".*")\n([^\n]+)$/gm)) {
        try {
          const url = /^https:\/\//i.test(match[2]) ? canonicalAttachmentUrl(match[2]) || match[2] : null;
          files.push({
            id: url || match[2],
            ...(url ? { url } : { path: match[2] }),
            name: JSON.parse(match[1]),
            kind: "file",
            status: "ready",
          });
        } catch {}
      }
      return files;
    }
    return [];
  });
}

/** @param {readonly {type: string; text?: string}[]} input */
export function composerTextFromInput(input = []) {
  return stripAttachmentWorkspaceContext(
    input
      .filter((part) => part.type === "text")
      .map((part) =>
        (part.text || "").replace(/^Attached file: (".*")\n([^\n]+)$/gm, (whole, name) => {
          try {
            JSON.parse(name);
            return "";
          } catch {
            return whole;
          }
        }),
      )
      .join("\n"),
  ).trim();
}

/** @param {readonly {type: string; text?: string; path?: string; url?: string}[]} input */
export function composerInputKey(input = []) {
  return JSON.stringify([
    stripAttachmentWorkspaceContext(
      input
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).replace(
      /^(Attached file: ".*")\n([^\n]+)$/gm,
      (whole, name, url) => `${name}\n${canonicalAttachmentUrl(url) || url}`,
    ),
    input
      .filter((part) => /image/i.test(part.type))
      .map((part) => part.path || canonicalAttachmentUrl(part.url) || part.url || ""),
  ]);
}
