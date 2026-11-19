import { CreationError } from "../contracts.js";
import { creationInteger, creationUuid } from "../validation.js";
import { creationTask, type CreationTaskRow } from "./records.js";

import type { CreationHistoryTask, CreationRoundPage } from "../history/contracts.js";
export interface CreationLineageRow extends CreationTaskRow {
  creationRootId: string;
  creationCreatedAt: number;
  creationRounds: number;
  latestTaskId?: string;
}
/** Legacy document identity is a fallback for roots only. Every continuation inherits its root across output types. */
export function creationLineageSql(mysql: boolean, project = false) {
  const table = mysql ? "panda_force_creation_tasks" : "creation_tasks",
    text = (path: string, field = "spec") =>
      mysql ? `JSON_UNQUOTE(JSON_EXTRACT(${field},'${path}'))` : `json_extract(${field},'${path}')`,
    key = (prefix: string, expression: string) =>
      mysql ? `CONCAT('${prefix}',${expression})` : `'${prefix}'||${expression}`;
  return `WITH RECURSIVE source AS${mysql ? "" : " MATERIALIZED"} (
    SELECT id,owner,projectId,${mysql ? "namespace," : ""}state,failure,createdAt,updatedAt,${text("$.previousTaskId")} AS previousId,${text("$.creationKey")} AS storedKey,
      COALESCE(${text("$.target.document.documentId")},${text("$.documentId", "artifact")}) AS documentKey
    FROM ${table} t WHERE ${mysql ? "namespace=? AND " : ""}owner=?${project ? " AND projectId=?" : ""}
  ), legacy AS${mysql ? "" : " MATERIALIZED"} (SELECT * FROM source WHERE storedKey IS NULL), lineage(id,projectId,historyKey,rootTaskId) AS (
    SELECT ${mysql ? "/*+ NO_MERGE(s) NO_MERGE(p) */ " : ""}s.id,s.projectId,CAST(COALESCE(p.storedKey,CASE WHEN s.documentKey IS NOT NULL THEN ${key("d:", "s.documentKey")} ELSE ${key("t:", "s.id")} END) AS CHAR(512)),CASE WHEN p.storedKey IS NULL THEN s.id WHEN p.storedKey LIKE 't:%' THEN SUBSTR(p.storedKey,3) ELSE NULL END
    FROM legacy s LEFT JOIN source p ON p.id=s.previousId AND p.projectId=s.projectId WHERE p.id IS NULL OR p.storedKey IS NOT NULL
    UNION ALL
    SELECT ${mysql ? "/*+ NO_MERGE(s) */ " : ""}s.id,s.projectId,l.historyKey,l.rootTaskId FROM legacy s JOIN lineage l ON s.previousId=l.id AND s.projectId=l.projectId
  ), mapped AS (
    SELECT ${mysql ? "/*+ NO_MERGE(s) */ " : ""}s.*,COALESCE(s.storedKey,l.historyKey,${key("t:", "s.id")}) AS historyKey,CASE WHEN s.storedKey LIKE 't:%' THEN SUBSTR(s.storedKey,3) ELSE l.rootTaskId END AS rootTaskId
    FROM source s LEFT JOIN lineage l ON l.id=s.id AND l.projectId=s.projectId
  ), identified AS (
    SELECT m.*,
      COALESCE(FIRST_VALUE(rootTaskId) OVER(PARTITION BY projectId,historyKey ORDER BY (rootTaskId IS NULL),createdAt,id),FIRST_VALUE(id) OVER(PARTITION BY projectId,historyKey ORDER BY createdAt,id)) AS creationRootId,
      MIN(createdAt) OVER(PARTITION BY projectId,historyKey) AS creationCreatedAt,
      COUNT(*) OVER(PARTITION BY projectId,historyKey) AS creationRounds
    FROM mapped m
  ) `;
}
export const creationHeadOrder =
  "CASE WHEN state IN ('queued','running','committing') AND failure IS NULL THEN 0 ELSE 1 END,createdAt DESC,id DESC";
export function creationHistoryTask(row: CreationLineageRow): CreationHistoryTask {
  return {
    ...creationTask(row),
    history: {
      rootId: row.creationRootId,
      createdAt: Number(row.creationCreatedAt),
      rounds: Number(row.creationRounds),
    },
  };
}
export function creationRoundCursor(cursor?: string) {
  if (cursor === undefined) return null;
  const match = /^(\d+):(.+)$/.exec(cursor);
  if (!match) throw new CreationError("invalidInput");
  return { at: creationInteger(Number(match[1])), id: creationUuid(match[2]) };
}
export function creationRoundPage(rows: CreationLineageRow[]): CreationRoundPage {
  if (!rows.length) throw new CreationError("invalidInput");
  const page = rows.slice(0, 10),
    last = page.at(-1)!;
  return {
    ids: page.map((row) => row.id),
    latestTaskId: rows[0]!.latestTaskId!,
    rootId: rows[0]!.creationRootId,
    createdAt: Number(rows[0]!.creationCreatedAt),
    rounds: Number(rows[0]!.creationRounds),
    nextCursor: rows.length > 10 ? `${last.createdAt}:${last.id}` : null,
  };
}
