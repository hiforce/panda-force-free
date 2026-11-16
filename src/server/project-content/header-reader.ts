import { ProjectContentError } from "./errors.js";
import { readProjectFileRange, type ProjectFileReader } from "./file-reader.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";

/** Canonical content files place a bounded record first and a schema footer last; payloads are not parsed here. */
export async function inspectContentHeader<T>(
  file: ProjectFileReader,
  first: "document" | "space",
  decode: (value: unknown) => T,
): Promise<{ record: T; fileBytes: number }> {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > PROJECT_CONTENT_LIMITS.fileBytes)
    throw new ProjectContentError("invalidFile");
  const prefix = Buffer.allocUnsafe(Math.min(65536, file.size));
  let position = 0,
    start = -1,
    cursor = 0,
    depth = 0,
    quoted = false,
    escaped = false;
  while (position < Math.min(65536, file.size)) {
    const bytes = await file.read(position, Math.min(4096, file.size - position, 65536 - position));
    if (!bytes.length) throw new ProjectContentError("invalidFile");
    bytes.copy(prefix, position);
    position += bytes.length;
    if (start < 0) {
      const match = new RegExp('^[ \\t\\r\\n]*\\{[ \\t\\r\\n]*"' + first + '"[ \\t\\r\\n]*:[ \\t\\r\\n]*\\{').exec(
        prefix.subarray(0, position).toString("latin1"),
      );
      if (!match) {
        if (position >= 128 || position >= file.size) throw new ProjectContentError("invalidFile");
        continue;
      }
      start = match[0].length - 1;
      cursor = start;
    }
    for (; cursor < position; cursor++) {
      const byte = prefix[cursor]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) quoted = false;
        continue;
      }
      if (byte === 34) quoted = true;
      else if (byte === 123) depth++;
      else if (byte === 125 && --depth === 0) {
        const footer = await readProjectFileRange(file, Math.max(0, file.size - 64), Math.min(64, file.size));
        const schema = /,[ \t\r\n]*"schema"[ \t\r\n]*:[ \t\r\n]*(0|[1-9]\d*)[ \t\r\n]*}[ \t\r\n]*$/.exec(
          footer.toString("utf8"),
        );
        if (!schema) throw new ProjectContentError("invalidFile");
        if (schema[1] !== "1") throw new ProjectContentError("unsupportedSchema");
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(prefix.subarray(start, cursor + 1));
          return { record: decode(JSON.parse(text)), fileBytes: file.size };
        } catch (error) {
          if (error instanceof ProjectContentError) throw error;
          throw new ProjectContentError("invalidFile");
        }
      }
    }
  }
  throw new ProjectContentError("invalidFile");
}
