import { SourceError } from "../../shared/packages/sources/contracts.js";

/** This races provider results only; owners still await filesystem work before releasing its resources. */
export function awaitSourceResult<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SourceError("sourceCancelled"));
    signal.addEventListener("abort", abort, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function sourceDeadline(caller: AbortSignal | undefined, milliseconds: number) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new SourceError("invalidSource");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref();
  return {
    signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
    error(error: unknown): SourceError {
      return caller?.aborted
        ? new SourceError("sourceCancelled")
        : controller.signal.aborted
          ? new SourceError("sourceTimedOut")
          : error instanceof SourceError
            ? error
            : new SourceError("sourceUnavailable");
    },
    close() {
      clearTimeout(timer);
    },
  };
}
