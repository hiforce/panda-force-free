import { reportDiagnostic } from "../../shared/diagnostics.js";
/** Instances may exchange declared presentation intents; business execution still uses authorized services. */
export class GadgetEvents {
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  subscribe(name: string, signal: AbortSignal, read: (value: unknown) => void) {
    if (signal.aborted) return;
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(read);
    signal.addEventListener(
      "abort",
      () => {
        set.delete(read);
        if (!set.size) this.listeners.delete(name);
      },
      { once: true },
    );
  }
  publish(name: string, value: unknown) {
    if (JSON.stringify(value).length > 64000) return false;
    const listeners = this.listeners.get(name);
    if (!listeners?.size) return false;
    for (const read of listeners)
      try {
        read(structuredClone(value));
      } catch (error) {
        reportDiagnostic("gadget.event-subscriber", error);
      }
    return true;
  }
}
