import { errorMessage } from "../../shared/errors.js";
import { isMessageId } from "../../shared/i18n/message-id.js";

// Only server-owned messages are localized. Native CLI/provider errors stay verbatim.
/** @param {unknown} payload @param {import("../../shared/i18n/messages.js").Translate} t @param {import("../../shared/i18n/messages.js").MessageId} fallback */
export function errorText(payload, t, fallback = "errors.unexpectedError") {
  if (typeof payload === "string") return payload || t(fallback);
  if (!payload || typeof payload !== "object") return t(fallback);
  if ("messageId" in payload && isMessageId(payload.messageId) && /^(auth|errors|projects)\./.test(payload.messageId)) {
    // Server error envelopes carry runtime-validated parameters, not compile-time literals.
    const translate = /** @type {(id: string, values: object) => string} */ (t);
    return translate(
      payload.messageId,
      "messageArgs" in payload && payload.messageArgs && typeof payload.messageArgs === "object"
        ? payload.messageArgs
        : {},
    );
  }
  const value = "error" in payload ? payload.error : payload;
  const message = errorMessage(value, t(fallback));
  return "additionalDetails" in payload && typeof payload.additionalDetails === "string" && payload.additionalDetails
    ? `${message}\n${payload.additionalDetails}`
    : message;
}
