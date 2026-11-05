let managedPrefix = "";

export function configureAttachmentUrls(prefix = "") {
  managedPrefix = typeof prefix === "string" ? prefix : "";
}

export function canonicalAttachmentUrl(value, prefix = managedPrefix) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return prefix && url.href.startsWith(prefix) ? url.href : null;
  } catch {
    return null;
  }
}

export function attachmentDisplayUrl(value) {
  const canonical = canonicalAttachmentUrl(value);
  return canonical ? `/api/attachments/read?url=${encodeURIComponent(canonical)}` : value;
}

export function attachmentUrlName(value) {
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").at(-1) || "") || "Attachment";
  } catch {
    return "Attachment";
  }
}
