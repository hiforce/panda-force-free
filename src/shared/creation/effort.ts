/** Creation prefers the strongest advertised effort without changing explicit choices. */
export function defaultCreationEffort(supported: readonly string[], fallback = ""): string {
  return (
    ["xhigh", "high", "medium", "low", "minimal", "none"].find((effort) => supported.includes(effort)) ||
    (supported.includes(fallback) ? fallback : supported.at(-1)) ||
    fallback
  );
}
