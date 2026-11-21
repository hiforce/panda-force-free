import { basename } from "node:path";
import { queryHarnessHistoryFile } from "./storage/history.js";
/** A local read-only runtime tool. HTTP authorization stays in HarnessConversations; this CLI uses OS file permissions. */
export async function runHarnessHistoryQuery(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!,
      value = args[index + 1];
    if (
      !["--file", "--committed-bytes", "--from", "--to", "--query", "--cursor"].includes(name) ||
      value === undefined ||
      values.has(name)
    )
      throw Error("invalidInput");
    values.set(name, value);
  }
  const path = values.get("--file"),
    from = values.get("--from"),
    to = values.get("--to");
  if (
    !path ||
    basename(path) !== "history.jsonl" ||
    !from ||
    !to ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(from) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(to)
  )
    throw Error("invalidInput");
  const cursor: unknown = values.has("--cursor") ? JSON.parse(values.get("--cursor")!) : undefined;
  if (
    cursor !== undefined &&
    (!cursor ||
      typeof cursor !== "object" ||
      !("indexOffset" in cursor) ||
      typeof cursor.indexOffset !== "number" ||
      ("afterSeq" in cursor && typeof cursor.afterSeq !== "number"))
  )
    throw Error("invalidInput");
  return queryHarnessHistoryFile(path, Number(values.get("--committed-bytes")), {
    from: Date.parse(from),
    to: Date.parse(to),
    query: values.get("--query"),
    cursor: cursor as { indexOffset: number; afterSeq?: number } | undefined,
    limit: 10,
  });
}
if (import.meta.main) {
  try {
    process.stdout.write(JSON.stringify(await runHarnessHistoryQuery(process.argv.slice(2))) + "\n");
  } catch {
    process.stderr.write(JSON.stringify({ messageId: "harness.errorInvalidInput" }) + "\n");
    process.exitCode = 1;
  }
}
