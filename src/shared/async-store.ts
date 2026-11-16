type AsyncStoreArguments<A extends unknown[]> = {
  [I in keyof A]: NonNullable<A[I]> extends (...args: infer P) => infer R
    ? (...args: P) => R | Promise<Awaited<R>>
    : A[I];
};
/** Neutral ports accept existing direct SQLite results and native asynchronous persistence. */
export type AwaitableStore<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>>
    : T[K];
};
export type AsyncStore<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => infer R
    ? (...args: AsyncStoreArguments<A>) => Promise<Awaited<R>>
    : T[K];
};
