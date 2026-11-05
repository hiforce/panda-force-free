import { Immer, current, enableMapSet, isDraft, isDraftable, type Draft } from "immer";
import { canonicalData, isDataView, readonlyData, type DataView } from "../../shared/read-model.js";

enableMapSet();
const producer = new Immer({ autoFreeze: false });
import type { MapKeys, MapKey, MapValue, StateMutations } from "../contracts/mutations.js";
export type { StateMutations } from "../contracts/mutations.js";

/** Only the owning store can provide the read/write closures for this capability. */
export function createStateMutations<S extends object>({
  read,
  write,
  requireWrite,
  changed,
}: {
  read: <K extends keyof S>(key: K) => S[K];
  write: <K extends keyof S>(key: K, value: S[K]) => void;
  requireWrite: (key: keyof S) => void;
  changed: (key: keyof S) => void;
}): StateMutations<S> {
  // A store materialization preserves its schema while detaching read-only inputs.
  const copy = <T>(value: T): T => canonicalData(value) as T;
  const owned = new WeakSet<object>();
  const isData = (value: unknown): value is object =>
    value !== null &&
    typeof value === "object" &&
    (Array.isArray(value) ||
      value instanceof Map ||
      value instanceof Set ||
      [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const rememberOwned = (value: unknown) => {
    if (!isData(value) || owned.has(value)) return;
    owned.add(value);
    if (value instanceof Map || value instanceof Set) {
      for (const entry of value.values()) rememberOwned(entry);
    } else for (const key of Object.keys(value)) rememberOwned(Reflect.get(value, key));
  };
  // Keep unchanged branches and detach inserted external records. Resources
  // retain their identity; only application data participates in transactions.
  const adopt = <T>(value: T, seen = new WeakMap<object, object>()): T => {
    if (isDataView(value)) return adopt(copy(value), seen);
    if (!isData(value) || owned.has(value)) return value;
    const existing = seen.get(value);
    if (existing) return existing as T;
    let result: object;
    if (value instanceof Map) {
      const map = new Map<unknown, unknown>();
      seen.set(value, map);
      for (const [key, entry] of value) map.set(key, adopt(entry, seen));
      result = map;
    } else if (value instanceof Set) {
      const set = new Set<unknown>();
      seen.set(value, set);
      for (const entry of value) set.add(adopt(entry, seen));
      result = set;
    } else {
      result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
      seen.set(value, result);
      for (const key of Object.keys(value)) Reflect.set(result, key, adopt(Reflect.get(value, key), seen));
    }
    owned.add(result);
    return result as T;
  };
  const commit = <K extends keyof S>(key: K, value: S[K]) => {
    if (Object.is(read(key), value)) return;
    write(key, adopt(value));
    changed(key);
  };
  const edit = <K extends keyof S, R>(key: K, change: (draft: Draft<NonNullable<S[K]>>) => R): DataView<R> => {
    requireWrite(key);
    const base = read(key);
    if (base === null || base === undefined || !isDraftable(base))
      throw new Error(`Only data fields support edits: ${String(key)}`);
    rememberOwned(base);
    let result: R;
    // A failed recipe never commits; drafts cannot remain writable after return.
    const next = producer.produce(base, (draft: Draft<NonNullable<S[K]>>) => {
      const returned = change(draft);
      result = (isDraft(returned) ? current(returned as Draft<R>) : returned) as R;
    });
    commit(key, next);
    return readonlyData(copy(result!));
  };
  return Object.freeze({
    patch(values: Partial<S> | DataView<Partial<S>>) {
      const keys = Object.keys(values) as Array<keyof S>;
      for (const key of keys) requireWrite(key);
      const fields = canonicalData(values) as Partial<S>;
      const updates = keys.map((key) => ({ key, value: adopt(fields[key]) as S[typeof key] }));
      const changedKeys = updates.filter(({ key, value }) => !Object.is(read(key), value));
      for (const { key, value } of changedKeys) write(key, value);
      for (const { key } of changedKeys) changed(key);
    },
    set<K extends keyof S>(key: K, value: S[K] | DataView<S[K]>) {
      requireWrite(key);
      if (Object.is(readonlyData(read(key)), value) || Object.is(read(key), value)) return;
      const prepared = canonicalData(value) as S[K];
      commit(key, prepared);
    },
    update<K extends keyof S>(key: K, change: (previous: DataView<S[K]>) => S[K], returnPrevious = false) {
      requireWrite(key);
      const before = readonlyData(read(key));
      const next = copy(change(before));
      commit(key, next);
      return returnPrevious ? before : readonlyData(read(key));
    },
    edit,
    collection<K extends MapKeys<S>>(key: K) {
      requireWrite(key);
      if (!(read(key) instanceof Map)) throw new Error(`State collection is not a Map: ${String(key)}`);
      return Object.freeze({
        set(id: MapKey<S[K]>, value: MapValue<S[K]> | DataView<MapValue<S[K]>>) {
          edit(key, (draft) => {
            if (!(draft instanceof Map)) throw new Error("State collection changed its type");
            draft.set(id, canonicalData(value));
          });
        },
        delete(id: MapKey<S[K]>) {
          return edit(key, (draft) => {
            if (!(draft instanceof Map)) throw new Error("State collection changed its type");
            return draft.delete(id);
          });
        },
        clear() {
          edit(key, (draft) => {
            if (!(draft instanceof Map)) throw new Error("State collection changed its type");
            draft.clear();
          });
        },
        update<R>(id: MapKey<S[K]>, change: (draft: Draft<MapValue<S[K]>>) => R) {
          return edit(key, (draft) => {
            if (!(draft instanceof Map) || !draft.has(id)) throw new Error("State collection entry is missing");
            return change(draft.get(id) as Draft<MapValue<S[K]>>);
          });
        },
      });
    },
  });
}
