import { serverTranslator } from "../i18n/messages.js";

// Machine-readable IDs are additive; older clients can still display English.
export function errorPayload(messageId, messageArgs = {}) {
  return { error: serverTranslator("en")(messageId, messageArgs), messageId, messageArgs };
}
