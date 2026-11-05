import type { RenderBatch } from "../contracts/platform.js";
// Shared render transaction, independent of timeline and individual projections.
export function createRenderBatch(): RenderBatch {
  let depth = 0;
  const listeners = new Set<(turnId: string) => void>();
  return Object.freeze({
    get active() {
      return depth > 0;
    },
    begin() {
      depth++;
    },
    end(turnId: string) {
      if (!depth) throw new Error("Unbalanced render batch");
      if (--depth) return;
      for (const listener of listeners) listener(turnId);
    },
    subscribe(listener: (turnId: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
