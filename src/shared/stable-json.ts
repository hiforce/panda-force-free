/** Object order cannot change the identity of a retried command; array order remains significant. */
export function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key: string, entry: unknown) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, Reflect.get(entry, key)]),
          )
        : entry,
    ) ?? "null"
  );
}
