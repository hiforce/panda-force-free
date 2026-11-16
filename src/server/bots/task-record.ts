import type { BotTask } from "../../shared/bots/contracts.js";
/** Canonical lifecycle is projected from operational facts, never stored as a second status authority. */
export function botTaskData(task: BotTask) {
  const data = { ...task };
  delete data.state;
  return JSON.stringify(data);
}
