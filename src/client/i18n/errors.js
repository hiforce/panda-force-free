// Only server-owned message IDs are localized. Native CLI/provider errors stay verbatim.
export function errorText(payload, t, fallback = "errors.unexpectedError") {
  if (typeof payload?.messageId === "string" && /^(auth|errors|projects)\./.test(payload.messageId))
    return t(payload.messageId, payload.messageArgs || {});
  return String(payload?.error?.message || payload?.error || payload?.message || t(fallback));
}
