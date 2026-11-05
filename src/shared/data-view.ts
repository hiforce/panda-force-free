/** Application data is read-only; runtime resources retain their native API. */
export type DataView<T> =
  T extends Map<infer K, infer V>
    ? ReadonlyMap<K, DataView<V>>
    : T extends Set<infer V>
      ? ReadonlySet<DataView<V>>
      : T extends readonly (infer V)[]
        ? readonly DataView<V>[]
        : T extends
              | Date
              | RegExp
              | WebSocket
              | EventSource
              | ReturnType<typeof setTimeout>
              | PromiseLike<unknown>
              | { nodeType: number }
              | ((...args: never[]) => unknown)
          ? T
          : T extends object
            ? { readonly [K in keyof T]: DataView<T[K]> }
            : T;

/** A detached materialization owns mutable data while keeping runtime resources intact. */
export type Materialized<T> =
  T extends ReadonlyMap<infer K, infer V>
    ? Map<K, Materialized<V>>
    : T extends ReadonlySet<infer V>
      ? Set<Materialized<V>>
      : T extends readonly (infer V)[]
        ? Materialized<V>[]
        : T extends
              | Date
              | RegExp
              | WebSocket
              | EventSource
              | ReturnType<typeof setTimeout>
              | PromiseLike<unknown>
              | { nodeType: number }
              | ((...args: never[]) => unknown)
          ? T
          : T extends object
            ? { -readonly [K in keyof T]: Materialized<T[K]> }
            : T;
