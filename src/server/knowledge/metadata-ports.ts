/** Both SQLite's direct results and native asynchronous stores satisfy this consumer port. */
export type MetadataStore<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>>
    : T[K];
};
export type AsyncMetadataStore<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : T[K];
};
