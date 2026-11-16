export type IndexBuildProgress = (completed: number, total: number) => void;
/** Bound provider notifications and durable metadata writes while always publishing first and final counts. */
export function indexBuildProgress(report?: IndexBuildProgress): IndexBuildProgress {
  let previous = -Infinity;
  return (completed, total) => {
    if (
      !report ||
      !Number.isSafeInteger(completed) ||
      !Number.isSafeInteger(total) ||
      completed < 0 ||
      completed > total
    )
      return;
    const now = Date.now();
    if (completed !== 0 && completed !== total && now - previous < 250) return;
    previous = now;
    report(completed, total);
  };
}
