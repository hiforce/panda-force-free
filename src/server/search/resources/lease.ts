import { SearchError } from "../../../shared/search/contracts.js";

/** Work loses authority on an expired durable lease, even when its old network request eventually returns. */
export async function withIndexResourceLease<T>(
  signal: AbortSignal,
  heartbeat: () => boolean | Promise<boolean>,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController(),
    active = AbortSignal.any([signal, controller.signal]);
  const timer = setInterval(async () => {
    try {
      if (!(await heartbeat())) controller.abort(new SearchError("conflict", 409));
    } catch (error) {
      controller.abort(error);
    }
  }, 30000);
  timer.unref();
  try {
    active.throwIfAborted();
    if (!(await heartbeat())) throw new SearchError("conflict", 409);
    const result = await work(active);
    active.throwIfAborted();
    if (!(await heartbeat())) throw new SearchError("conflict", 409);
    return result;
  } finally {
    clearInterval(timer);
  }
}
