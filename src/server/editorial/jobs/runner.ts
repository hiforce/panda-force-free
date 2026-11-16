import { reportDiagnostic } from "../../../shared/diagnostics.js";
import type { EditorialWorker } from "./worker.js";

/** One process-local loop; the persistent repository still owns cross-process lease authority. */
export function editorialRunner(worker: Pick<EditorialWorker, "runOne">) {
  const stopping = new AbortController();
  let started = false,
    timer: ReturnType<typeof setTimeout> | null = null,
    flight: Promise<void> | null = null;
  function schedule(delay: number) {
    if (stopping.signal.aborted || !started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
    timer.unref();
  }
  function tick() {
    timer = null;
    if (flight || stopping.signal.aborted) return;
    flight = (async () => {
      let more = false;
      try {
        more = await worker.runOne(stopping.signal);
      } catch (error) {
        reportDiagnostic("editorial-runner", error);
      } finally {
        flight = null;
        schedule(more ? 0 : 1000);
      }
    })();
  }
  return {
    start() {
      if (!started) {
        started = true;
        schedule(0);
      }
    },
    wake() {
      if (!flight) schedule(0);
    },
    async stop() {
      stopping.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      await flight;
    },
  };
}
