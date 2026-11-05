import type { DataView, Materialized } from "./data-view.js";
export type { DataView } from "./data-view.js";
type PlainData = Record<PropertyKey, unknown> | unknown[];

const views = new WeakMap<object, object>();
const originals = new WeakMap<object, object>();
export const isDataView = (value: unknown): boolean =>
  value !== null && typeof value === "object" && originals.has(value);
const isObject = (value: unknown): value is object => value !== null && typeof value === "object";
const isPlain = (value: unknown): value is PlainData =>
  isObject(value) && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/** Views protect records and nested collections while preserving resource identities. */
export function readonlyData<T>(value: T): DataView<T> {
  if (!isObject(value) || (!isPlain(value) && !(value instanceof Map) && !(value instanceof Set)))
    return value as DataView<T>;
  if (originals.has(value)) return value as DataView<T>;
  const existing = views.get(value);
  if (existing) return existing as DataView<T>;
  const deny = (): never => {
    throw new Error("Read-only domain record; use its mutation capability");
  };
  let view: object;
  if (value instanceof Map) {
    const map: Map<unknown, unknown> = value;
    const result: ReadonlyMap<unknown, unknown> = Object.freeze({
      get size() {
        return map.size;
      },
      get: (key: unknown) => readonlyData(map.get(key)),
      has: (key: unknown) => map.has(key),
      keys: () => map.keys(),
      *values() {
        for (const item of map.values()) yield readonlyData(item);
        return undefined;
      },
      *entries() {
        for (const [key, item] of map) yield [key, readonlyData(item)] as [unknown, unknown];
        return undefined;
      },
      forEach(callback: (value: unknown, key: unknown, map: ReadonlyMap<unknown, unknown>) => void, context?: unknown) {
        map.forEach((item, key) => callback.call(context, readonlyData(item), key, result));
      },
      [Symbol.iterator]() {
        return this.entries();
      },
    });
    view = result;
  } else if (value instanceof Set) {
    const set: Set<unknown> = value;
    const result: ReadonlySet<unknown> = Object.freeze({
      get size() {
        return set.size;
      },
      has: (item: unknown) => set.has(item),
      *keys() {
        for (const item of set) yield readonlyData(item);
        return undefined;
      },
      *values() {
        yield* this.keys();
        return undefined;
      },
      *entries() {
        for (const item of set) {
          const read = readonlyData(item);
          yield [read, read] as [unknown, unknown];
        }
        return undefined;
      },
      forEach(callback: (value: unknown, key: unknown, set: ReadonlySet<unknown>) => void, context?: unknown) {
        set.forEach((item) => callback.call(context, readonlyData(item), readonlyData(item), result));
      },
      [Symbol.iterator]() {
        return this.values();
      },
    });
    view = result;
  } else {
    view = new Proxy(value, {
      get(target, key, receiver) {
        const result: unknown = Reflect.get(target, key, receiver);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        // Frozen data is already protected; proxy invariants require its exact value.
        return descriptor && !descriptor.configurable && "value" in descriptor && !descriptor.writable
          ? result
          : readonlyData(result);
      },
      set: deny,
      deleteProperty: deny,
      defineProperty: deny,
      setPrototypeOf: deny,
      preventExtensions: deny,
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return descriptor?.configurable && "value" in descriptor
          ? { ...descriptor, value: readonlyData(descriptor.value) }
          : descriptor;
      },
    });
  }
  views.set(value, view);
  originals.set(view, value);
  return view as DataView<T>;
}

/** Materialize data without exposing the writable object behind a read view. */
export function canonicalData<T>(value: T, seen?: WeakMap<object, object>): Materialized<T>;
export function canonicalData<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (!isObject(value)) return value;
  const source = originals.get(value) || value;
  const existing = seen.get(source);
  if (existing) return existing as T;
  if (source instanceof Map) {
    const map: Map<unknown, unknown> = source;
    const result = new Map<unknown, unknown>();
    seen.set(source, result);
    for (const [key, item] of map) result.set(key, canonicalData(item, seen));
    return result as T;
  }
  if (source instanceof Set) {
    const result = new Set<unknown>();
    seen.set(source, result);
    for (const item of source) result.add(canonicalData(item, seen));
    return result as T;
  }
  if (!isPlain(source)) return source as T;
  const result: PlainData = Array.isArray(source) ? [] : Object.create(Object.getPrototypeOf(source));
  seen.set(source, result);
  for (const key of Object.keys(source)) Reflect.set(result, key, canonicalData(Reflect.get(source, key), seen));
  return result as T;
}
