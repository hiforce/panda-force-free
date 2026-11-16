import { createHash } from "node:crypto";
import { fileRecord } from "./codec-values.js";
import { ProjectContentError } from "./errors.js";
import { projectContentId } from "./paths.js";

export const projectRecordShard = (id: string) =>
  createHash("sha256").update(projectContentId(id)).digest("hex").slice(0, 2);

/** Fixed shards bound the Git path count independently of record count; each domain retains its own closed record codec. */
export function decodeProjectRecordShard<T>(
  value: unknown,
  field: "assets" | "operations" | "placements",
  decode: (value: unknown) => T,
  identity: (record: T) => string,
) {
  const v = fileRecord(value, ["schema", "projectId", "shard", field]);
  if (v.schema !== 1) throw new ProjectContentError("unsupportedSchema");
  const records = v[field];
  if (
    typeof v.shard !== "string" ||
    !/^[a-f0-9]{2}$/.test(v.shard) ||
    !Array.isArray(records) ||
    records.length > 10000
  )
    throw new ProjectContentError("invalidFile");
  const values = records.map(decode),
    ids = new Set<string>();
  for (const record of values) {
    const id = projectContentId(identity(record));
    if (ids.has(id) || projectRecordShard(id) !== v.shard) throw new ProjectContentError("invalidFile");
    ids.add(id);
  }
  return { schema: 1 as const, projectId: projectContentId(v.projectId), shard: v.shard, records: values };
}
