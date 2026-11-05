import { readonlyData, canonicalData } from "./read-model.js";
import { FIELD_DOMAINS, STATE_CONTRACTS } from "./state-contracts.js";

// Each domain stores its fields once. Feature views are accessors, not copies.
// Compatibility writers exist only for controllers with an approved write grant.
export function createStateDomains(
  initial,
  { onListenerError = (error) => console.error("[panda-force] state subscriber failed", error) } = {},
) {
  const guardedDomains = new Set([
    "sessions",
    "configuration",
    "workspace",
    "composer",
    "models",
    "goals",
    "usage",
    "account",
  ]);
  const domains = new Map(),
    scopes = new Map(),
    listeners = new Set(),
    mapReaders = new WeakMap();
  for (const [key, value] of Object.entries(initial)) {
    const domain = FIELD_DOMAINS[key];
    if (!domain) throw new Error(`Unowned state field: ${key}`);
    if (!domains.has(domain)) domains.set(domain, Object.create(null));
    domains.get(domain)[key] = value;
  }
  const valueOf = (key) => domains.get(FIELD_DOMAINS[key])[key];
  function changed(key) {
    const change = Object.freeze({ domain: FIELD_DOMAINS[key], field: key });
    for (const listener of [...listeners])
      try {
        listener(change);
      } catch (error) {
        onListenerError(error);
      }
  }
  function readMap(map, guarded) {
    const cached = mapReaders.get(map) || new Map();
    if (cached.has(guarded)) return cached.get(guarded);
    const read = (value) => (guarded ? readonlyData(value) : value);
    const result = Object.freeze({
      get size() {
        return map.size;
      },
      get: (key) => read(map.get(key)),
      has: (key) => map.has(key),
      keys: () => map.keys(),
      *values() {
        for (const value of map.values()) yield read(value);
      },
      *entries() {
        for (const [key, value] of map) yield [key, read(value)];
      },
      forEach: (fn, context) => map.forEach((value, key) => fn.call(context, read(value), key, result)),
      [Symbol.iterator]() {
        return result.entries();
      },
    });
    cached.set(guarded, result);
    mapReaders.set(map, cached);
    return result;
  }
  function scope(owner, { testing = false } = {}) {
    const cacheKey = owner + (testing ? ":testing" : "");
    if (scopes.has(cacheKey)) return scopes.get(cacheKey);
    const contract = STATE_CONTRACTS[owner];
    if (!contract) throw new Error(`Unknown state consumer: ${owner}`);
    const readable = new Set(testing ? Object.keys(FIELD_DOMAINS) : contract.read);
    const writable = new Set(testing ? Object.keys(FIELD_DOMAINS) : contract.write);
    function requireWrite(key) {
      if (!writable.has(key)) throw new Error(`State write denied: ${owner}.${key}`);
    }
    const mutations = Object.freeze({
      set(key, value) {
        requireWrite(key);
        if (Object.is(valueOf(key), value)) return;
        domains.get(FIELD_DOMAINS[key])[key] = canonicalData(value);
        changed(key);
      },
      edit(key, fn) {
        requireWrite(key);
        const result = fn(valueOf(key));
        changed(key);
        return result;
      },
      collection(key) {
        requireWrite(key);
        const map = valueOf(key);
        return Object.freeze({
          set(id, value) {
            map.set(id, canonicalData(value));
            changed(key);
          },
          delete(id) {
            const removed = map.delete(id);
            if (removed) changed(key);
            return removed;
          },
          clear() {
            if (!map.size) return;
            map.clear();
            changed(key);
          },
        });
      },
    });
    function view(legacy) {
      const result = Object.create(null);
      for (const key of readable)
        Object.defineProperty(result, key, {
          enumerable: true,
          get() {
            const value = valueOf(key);
            if (legacy && writable.has(key)) return value;
            return value instanceof Map
              ? readMap(value, guardedDomains.has(FIELD_DOMAINS[key]))
              : guardedDomains.has(FIELD_DOMAINS[key])
                ? readonlyData(value)
                : Array.isArray(value)
                  ? Object.freeze(value.slice())
                  : value;
          },
          set(value) {
            if (!legacy) throw new Error(`Read-only state: ${owner}.${key}`);
            mutations.set(key, value);
          },
        });
      return Object.freeze(result);
    }
    const result = Object.freeze({ state: view(false), legacyState: view(true), mutations });
    scopes.set(cacheKey, result);
    return result;
  }
  return Object.freeze({
    scope,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
