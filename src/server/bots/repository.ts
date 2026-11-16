import type { BotStore } from "./store.js";

type Awaitable<T> = T | Promise<T>;
type RepositoryMethods = Omit<BotStore, "db" | "avatars" | "hasSession">;

/** Callers await storage work; synchronous session exclusion remains available before routing. */
export type BotRepository = {
  [K in keyof RepositoryMethods]: RepositoryMethods[K] extends (...args: infer A) => infer R
    ? (...args: A) => Awaitable<R>
    : never;
} & {
  hasSession(id: string): boolean;
  avatars: { read(owner: string, id: string): Awaitable<Uint8Array> };
};
