import { randomUUID } from "node:crypto";
import { creationOperation } from "../../../shared/creation/progress.js";
import type { CreationProgress } from "../../../shared/creation/contracts.js";
import type { ApplicationToolResult } from "../../../shared/engine/application-tools.js";
import type { CreationLease } from "../contracts.js";
import type { CreationProgressStore } from "../ports.js";

/** One durable, bounded entry follows the actual tool call from dispatch to its observed outcome. */
export async function creationToolActivity(
  store: CreationProgressStore | undefined,
  lease: CreationLease,
  name: string,
  run: () => Promise<ApplicationToolResult>,
  now: () => number,
  diagnostic: (error: unknown) => void,
) {
  if (!creationOperation(name)) return run();
  const id = randomUUID(),
    at = now();
  const record = async (status: CreationProgress["status"]) => {
    try {
      await store?.record(lease, { id, at, generation: lease.generation, stage: "activity", operation: name, status });
    } catch (error) {
      diagnostic(error);
    }
  };
  await record("running");
  try {
    const result = await run();
    await record(result.success ? "completed" : "failed");
    return result;
  } catch (error) {
    await record("failed");
    throw error;
  }
}
