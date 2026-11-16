import type { MetadataStore } from "../metadata-ports.js";
import { knowledgeId, knowledgeObject, knowledgeText } from "../../../shared/knowledge/primitives.js";
import {
  KnowledgeTaskError,
  type KnowledgeTaskPosition,
  type KnowledgeTaskReads,
  type KnowledgeContent,
  type KnowledgeTaskRow,
} from "./contracts.js";
function decodeCursor(owner: string, project: string, value?: string): KnowledgeTaskPosition | undefined {
  if (value === undefined) return undefined;
  try {
    knowledgeText(value, 1000);
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw Error();
    const p = knowledgeObject(JSON.parse(bytes.toString("utf8")), ["schema", "owner", "project", "position"]);
    if (p.schema !== 1 || p.owner !== owner || p.project !== project) throw Error();
    const at = knowledgeObject(p.position, ["createdAt", "id", "watermark"]),
      watermark = knowledgeObject(at.watermark, ["rowid", "id"]);
    if (
      !Number.isSafeInteger(at.createdAt) ||
      Number(at.createdAt) < 0 ||
      !Number.isSafeInteger(watermark.rowid) ||
      Number(watermark.rowid) < 1
    )
      throw Error();
    return {
      createdAt: Number(at.createdAt),
      id: knowledgeId(at.id),
      watermark: { rowid: Number(watermark.rowid), id: knowledgeId(watermark.id) },
    };
  } catch {
    throw new KnowledgeTaskError("invalidInput");
  }
}
/** A scoped append watermark excludes new arrivals, including inserts with an identical creation time. */
export async function knowledgeTaskHistory<T>(
  records: Pick<MetadataStore<KnowledgeTaskReads>, "page">,
  content: Pick<KnowledgeContent, "authorize">,
  views: (tasks: KnowledgeTaskRow[]) => T[] | Promise<T[]>,
  owner: string,
  project: string,
  cursor?: string,
) {
  knowledgeId(project);
  const position = decodeCursor(owner, project, cursor);
  await content.authorize(owner, project);
  const page = await records.page(owner, project, position);
  const tasks = await views(page.tasks);
  await content.authorize(owner, project);
  return {
    tasks,
    nextCursor: page.next
      ? Buffer.from(JSON.stringify({ schema: 1, owner, project, position: page.next })).toString("base64url")
      : null,
  };
}
