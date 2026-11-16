type Awaitable<T> = T | Promise<T>;
export interface SessionRevocations {
  has(token: string): Awaitable<boolean>;
  revoke(token: string): Awaitable<void>;
  watch(token: string, close: () => void): Awaitable<() => void>;
  close(): void;
}
