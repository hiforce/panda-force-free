/** Return valid UTF-8 text within a byte budget, including malformed or partial stream input. */
export function utf8Prefix(value: string | Uint8Array, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError("Invalid UTF-8 byte limit");
  const text = typeof value === "string" ? value : new TextDecoder().decode(value);
  const bytes = new TextEncoder().encode(text).subarray(0, maximum);
  // Streaming decode leaves an incomplete final code point buffered instead of inserting a replacement.
  return new TextDecoder().decode(bytes, { stream: true });
}
