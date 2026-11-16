/** Format routing reads four bytes, never unpacks or executes a source in the browser. */
export async function templateImportFormat(file: File): Promise<"archive" | "json"> {
  if (/\.(?:zip|pptx|potx|pptm|potm)$/i.test(file.name)) return "archive";
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return signature[0] === 0x50 &&
    signature[1] === 0x4b &&
    ((signature[2] === 3 && signature[3] === 4) ||
      (signature[2] === 5 && signature[3] === 6) ||
      (signature[2] === 7 && signature[3] === 8))
    ? "archive"
    : "json";
}
