import type { IndexResourceLifecycle } from "./lifecycle.js";
export interface IndexResourceCursor {
  physical: string | null;
  allocations: string | null;
}
export interface IndexResourceBatch {
  checked: number;
  protected: number;
  unowned: number;
  unverified: number;
  missing: number;
  removed: number;
  failed: number;
  namespaceCount: number | null;
}
export interface IndexResourceObservation {
  name: string;
  status: "retained" | "protected" | "unowned" | "unverified" | "removed" | "unavailable";
  missing: boolean;
}
/** A bounded, fair inventory pass never invokes embeddings, adopts unknown collections or infers global health. */
export async function reconcileIndexResources(
  owner: IndexResourceLifecycle,
  cursor: IndexResourceCursor,
  signal: AbortSignal,
  reportError: (error: unknown) => void,
) {
  signal.throwIfAborted();
  const physical = cursor.physical === null ? null : await owner.storage.inventory(cursor.physical, signal),
    allocations = cursor.allocations === null ? [] : await owner.registry.page(owner.storage.id, cursor.allocations),
    physicalNames = physical?.names.slice(0, 8) ?? [],
    allocationNames = allocations.slice(0, 8).map((row) => row.name),
    names = [...new Set([...physicalNames, ...allocationNames])],
    observations: IndexResourceObservation[] = [],
    report: IndexResourceBatch = {
      checked: 0,
      protected: 0,
      unowned: 0,
      unverified: 0,
      missing: 0,
      removed: 0,
      failed: 0,
      namespaceCount: physical?.ownedNamespaceCount ?? null,
    };
  async function check(name: string) {
    signal.throwIfAborted();
    const observation: IndexResourceObservation = { name, status: "unavailable", missing: false };
    try {
      const current = await owner.storage.inspect(name, signal),
        row = await owner.registry.observe(owner.storage.id, name, current);
      report.checked++;
      if (!row) {
        observation.status = "unowned";
        report.unowned++;
        return;
      }
      observation.missing = !current;
      if (!current) report.missing++;
      if (row.state === "unverified") {
        observation.status = "unverified";
        report.unverified++;
        return;
      }
      if (await owner.registry.protected(row)) {
        observation.status = "protected";
        report.protected++;
        return;
      }
      observation.status = "retained";
      if (row.state !== "deleted" && (await owner.drop(name, false, signal))) {
        observation.status = "removed";
        observation.missing = false;
        report.removed++;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      observation.status = "unavailable";
      report.failed++;
      reportError(error);
    } finally {
      observations.push(observation);
    }
  }
  // Bound independent network work, and drain both operations before releasing an aborted batch.
  for (let offset = 0; offset < names.length; offset += 2) {
    const results = await Promise.allSettled(names.slice(offset, offset + 2).map(check));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  const next: IndexResourceCursor = {
    physical:
      physical && (physical.names.length > physicalNames.length || physical.next !== null)
        ? physicalNames.at(-1)!
        : null,
    allocations: allocations.length > allocationNames.length ? allocationNames.at(-1)! : null,
  };
  return { next, report, observations };
}
