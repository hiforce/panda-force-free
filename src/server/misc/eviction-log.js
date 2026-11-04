/**
 * Low-frequency logger for silent cache evictions (audit §3.3): warns on the
 * first eviction and then every `every` evictions, so capacity pressure is
 * visible without flooding the log.
 */
export function createEvictionLogger(label, every = 50) {
  let count = 0;
  return (detail) => {
    count += 1;
    if (count === 1 || count % every === 0) {
      console.warn(`[panda-force] ${label}: ${count} cache eviction(s) so far${detail ? ` (${detail})` : ""}`);
    }
  };
}
