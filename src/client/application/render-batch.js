// Shared render transaction, independent of timeline and individual projections.
export function createRenderBatch() {
  let depth = 0;
  const listeners = new Set();
  return Object.freeze({
    get active() {
      return depth > 0;
    },
    begin() {
      depth++;
    },
    end(turnId) {
      if (!depth) throw new Error("Unbalanced render batch");
      if (--depth) return;
      for (const listener of listeners) listener(turnId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
