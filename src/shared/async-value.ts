/** Metadata adapters may complete synchronously on SQLite or asynchronously on a native database. */
export type MetadataStore<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<Awaited<R>> : T[K];
};
export type MetadataMethod<S, K extends keyof S> = S[K] extends (...args: never[]) => infer R ? R : never;
export type MetadataResult<S, R> = S extends PromiseLike<unknown> ? Promise<Awaited<R>> : R;
export const isMetadataPending = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  "then" in value &&
  typeof value.then === "function";
/** Preserve synchronous default adapters without ever blocking on an asynchronous database. */
export function mapMetadata<S, R>(value: S, read: (value: Awaited<S>) => R): MetadataResult<S, R> {
  return (isMetadataPending(value) ? Promise.resolve(value).then(read) : read(value as Awaited<S>)) as MetadataResult<
    S,
    R
  >;
}
export function metadataFailure<T>(read: () => T, failed: (error: unknown) => never): T {
  try {
    const value = read();
    return (isMetadataPending(value) ? Promise.resolve(value).catch(failed) : value) as T;
  } catch (error) {
    return failed(error);
  }
}
/** Concrete synchronous stores retain their existing return types; native stores expose awaitable metadata. */
export type MetadataValue<S, B, T> = S extends B ? T : T | Promise<T>;
