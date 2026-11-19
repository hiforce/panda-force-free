import type { CreationTaskView } from "../../shared/creation/contracts.js";
export type ActivityTask = { task: CreationTaskView; scope: "personal" | "application" };

/** Cached legacy rows also coalesce before a fresh grouped list arrives. Scope and project remain hard boundaries. */
export function aggregateCreationActivity(rows: ActivityTask[]): ActivityTask[] {
  const known = new Map(rows.map((row) => [JSON.stringify([row.scope, row.task.projectId, row.task.id]), row.task]));
  const key = (row: ActivityTask) => {
    let task = row.task;
    const seen = new Set<string>();
    while (task.previousTaskId && !task.creation && !seen.has(task.id)) {
      seen.add(task.id);
      const parent = known.get(JSON.stringify([row.scope, task.projectId, task.previousTaskId]));
      if (!parent) return JSON.stringify([row.scope, task.projectId, task.previousTaskId]);
      task = parent;
    }
    return JSON.stringify([
      row.scope,
      task.projectId,
      task.creation?.id ||
        task.document?.documentId ||
        (task.artifact?.kind === "document" ? task.artifact.documentId : null) ||
        task.id,
    ]);
  };
  const seen = new Set<string>(),
    active = (task: CreationTaskView) => !task.failure && ["queued", "running", "committing"].includes(task.state);
  return [...rows]
    .sort(
      (a, b) =>
        Number(active(b.task)) - Number(active(a.task)) ||
        b.task.createdAt - a.task.createdAt ||
        b.task.id.localeCompare(a.task.id),
    )
    .filter((row) => {
      const identity = key(row);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}
