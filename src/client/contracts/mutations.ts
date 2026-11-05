import type { Draft } from "immer";
import type { DataView } from "../../shared/data-view.js";

export type MapKeys<S> = { [K in keyof S]: S[K] extends Map<unknown, unknown> ? K : never }[keyof S];
export type MapKey<T> = T extends Map<infer K, unknown> ? K : never;
export type MapValue<T> = T extends Map<unknown, infer V> ? V : never;

export interface StateMutations<S extends object> {
  patch(values: keyof S extends never ? never : Partial<S> | DataView<Partial<S>>): void;
  set<K extends keyof S>(key: K, value: S[K] | DataView<S[K]>): void;
  update<K extends keyof S>(
    key: K,
    change: (previous: DataView<S[K]>) => S[K],
    returnPrevious?: boolean,
  ): DataView<S[K]>;
  edit<K extends keyof S, R>(key: K, change: (draft: Draft<NonNullable<S[K]>>) => R): DataView<R>;
  collection<K extends MapKeys<S>>(
    key: K,
  ): {
    set(id: MapKey<S[K]>, value: MapValue<S[K]> | DataView<MapValue<S[K]>>): void;
    delete(id: MapKey<S[K]>): boolean;
    clear(): void;
    update<R>(id: MapKey<S[K]>, change: (draft: Draft<MapValue<S[K]>>) => R): DataView<R>;
  };
}
