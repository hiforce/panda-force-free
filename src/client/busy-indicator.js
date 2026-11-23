import { messageHtml } from "./i18n.js";

export const busyIndicator = '<span class="busy-indicator" aria-hidden="true"></span>';

/** @param {import("../shared/i18n/messages.js").Translate} t @param {import("../shared/i18n/messages.js").MessageId} label */
export function busyStatus(t, label) {
  return busyIndicator + messageHtml(label, undefined, t);
}
