export function activityText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(activityText).filter(Boolean).join("\n");
  if (
    value &&
    typeof value.text === "string" &&
    (!value.type || ["text", "summary_text", "reasoning_text"].includes(value.type))
  )
    return value.text;
  return "";
}

export function mergeReasoningItem(previous, next) {
  if (next.type !== "reasoning" || previous?.type !== "reasoning") return next;
  const result = { ...previous, ...next };
  for (const key of ["summary", "content"])
    if (!activityText(next[key]).trim() && activityText(previous[key]).trim()) result[key] = previous[key];
  return result;
}
