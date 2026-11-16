import { SourceStageError } from "../../../shared/packages/stages/contracts.js";

/** Shutdown stops admissions first, then drains all asynchronous use cases before metadata can close. */
export class SourceStageOperations {
  private stopping = false;
  private pending = new Set<Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  scope(id: string): AbortController {
    if (this.stopping || this.controllers.has(id)) throw new SourceStageError("stageBusy");
    const controller = new AbortController();
    this.controllers.set(id, controller);
    return controller;
  }
  finish(id: string, controller: AbortController) {
    if (this.controllers.get(id) === controller) this.controllers.delete(id);
  }
  abort(id: string) {
    this.controllers.get(id)?.abort();
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new SourceStageError("stageUnavailable"));
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
    const pending = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.pending.add(pending);
    try {
      work().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return pending.finally(() => {
      this.pending.delete(pending);
    });
  }
  async drain(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
