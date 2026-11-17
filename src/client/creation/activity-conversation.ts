import type { CreationTaskDetail } from "../../shared/creation/contracts.js";

export async function previousCreationRounds(
  current: CreationTaskDetail,
  read: (id: string) => Promise<{ task: CreationTaskDetail }>,
  cache: Map<string, { task: CreationTaskDetail; at: number }>,
) {
  const rounds = [current],
    seen = new Set([current.id]);
  let previous = current.previousTaskId;
  while (previous && rounds.length < 20 && !seen.has(previous)) {
    seen.add(previous);
    const stored = cache.get(previous);
    const task = stored && Date.now() - stored.at < 10000 ? stored.task : (await read(previous)).task;
    cache.set(previous, { task, at: Date.now() });
    rounds.unshift(task);
    previous = task.previousTaskId;
  }
  while (cache.size > 20) cache.delete(cache.keys().next().value!);
  return rounds;
}
