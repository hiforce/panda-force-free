import { isMessageId } from "../../shared/i18n/message-id.js";
import { serverTranslator } from "./messages.js";

// Machine-readable IDs are additive; older clients can still display English.
export function errorPayload(messageId, messageArgs = {}) {
  if (!isMessageId(messageId)) return { error: String(messageId) };
  return { error: serverTranslator("en")(messageId, messageArgs), messageId, messageArgs };
}
