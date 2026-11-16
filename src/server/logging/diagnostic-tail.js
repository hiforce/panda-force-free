/** Preserve a bounded UTF-8 diagnostic after both process pipes have drained. */
export function createDiagnosticTail(maxBytes) {
  let tail = Buffer.alloc(0);
  return {
    append(text) {
      if (!maxBytes || !text) return;
      const bytes = Buffer.concat([tail, Buffer.from(text)]);
      let start = Math.max(0, bytes.length - maxBytes);
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      tail = Buffer.from(bytes.subarray(start));
    },
    text: () => tail.toString("utf8"),
  };
}
