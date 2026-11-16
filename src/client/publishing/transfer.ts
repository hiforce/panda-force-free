import { request } from "../http-client.js";
import { sanitizeRichText } from "../html-safety.js";
import { PublishingApiError } from "./api.js";

/** Transfer owns browser capabilities, not publication state or document revisions. */
export async function copyVariant(text: string, html?: string) {
  if (html && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    const item = new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([sanitizeRichText(html, { allowStyles: true })], { type: "text/html" }),
    });
    await navigator.clipboard.write([item]);
    return;
  }
  if (!navigator.clipboard?.writeText)
    throw new PublishingApiError(400, { messageId: "publishing.clipboardUnavailable" });
  await navigator.clipboard.writeText(text);
}
export async function downloadVariant(url: string) {
  const response = await request(url);
  if (!response.ok) throw new PublishingApiError(response.status, await response.json());
  const blob = await response.blob(),
    link = document.createElement("a"),
    objectUrl = URL.createObjectURL(blob);
  const encoded = response.headers.get("content-disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  link.download = encoded ? decodeURIComponent(encoded) : "document-export";
  link.href = objectUrl;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
