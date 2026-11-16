/** Use the native JSON parser's lexical source so physical int64 identity survives without a custom JSON parser. */
export function parseSearchResponse(text: string, milvus: boolean) {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (!milvus || key !== "collectionID" || typeof value !== "number") return value;
    const source = context?.source ?? (Number.isSafeInteger(value) ? String(value) : "");
    if (!/^[1-9][0-9]{0,18}$/.test(source) || BigInt(source) > 9223372036854775807n)
      throw new Error("Invalid physical collection identity");
    return source;
  });
}
