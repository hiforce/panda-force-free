import { canonicalData, readonlyData } from "../../shared/read-model.js";
import type { ApplicationState } from "../contracts/state.js";
import type { StateChange, StateScope, StateStore } from "../contracts/ownership.js";
import type { StateOwner } from "../contracts/state-grants.js";
import { createInitialState } from "./initial-state.js";
import { FIELD_DOMAINS, STATE_CONTRACTS } from "./state-contracts.js";
import { createStateMutations } from "./state-mutations.js";

type StateKey = keyof ApplicationState;
type TestScope = ReturnType<StateStore["scope"]>;
type ScopeResult<O extends StateOwner> = StateScope<O> | TestScope;

/** One backing store publishes scoped reads and explicit, transactional writers. */
export function createStateDomains(
  initial: Partial<ApplicationState>,
  { onListenerError = (error: unknown) => console.error("[PandaForce] State subscriber failed", error) } = {},
): StateStore {
  const fields: Readonly<Record<StateKey, string>> = FIELD_DOMAINS;
  for (const key of Object.keys(initial)) if (!(key in fields)) throw new Error(`Unowned state field: ${key}`);
  const state: ApplicationState = canonicalData({ ...createInitialState(), ...initial });
  const scopes = new Map<string, unknown>();
  const listeners = new Set<(change: StateChange) => void>();
  const read = <K extends StateKey>(key: K): ApplicationState[K] => state[key];
  const write = <K extends StateKey>(key: K, value: ApplicationState[K]): void => {
    state[key] = value;
  };
  const changed = (key: StateKey) => {
    const change = Object.freeze({ domain: fields[key], field: key });
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        onListenerError(error);
      }
    }
  };
  function scope<O extends StateOwner>(owner: O, { testing = false } = {}): ScopeResult<O> {
    const cacheKey = owner + (testing ? ":testing" : "");
    const existing = scopes.get(cacheKey);
    if (existing) return existing as ScopeResult<O>;
    const contract = STATE_CONTRACTS[owner];
    if (!contract) throw new Error(`Unknown state consumer: ${owner}`);
    if (testing && owner !== "diagnostics") throw new Error("Only the isolated diagnostics scope supports test grants");
    const readable = new Set<StateKey>(testing ? (Object.keys(fields) as StateKey[]) : (contract.read as StateKey[]));
    const writable = new Set<StateKey>(testing ? (Object.keys(fields) as StateKey[]) : (contract.write as StateKey[]));
    const mutations = createStateMutations<ApplicationState>({
      read,
      write,
      changed,
      requireWrite(key) {
        if (!writable.has(key)) throw new Error(`State write denied: ${owner}.${key}`);
      },
    });
    const view: Partial<Record<StateKey, unknown>> = Object.create(null);
    for (const key of readable)
      Object.defineProperty(view, key, {
        enumerable: true,
        get: () => readonlyData(read(key)),
        set: () => {
          throw new Error(`Read-only state: ${owner}.${key}`);
        },
      });
    // The reviewed grants determine this dynamically assembled property set.
    const result = Object.freeze({ state: Object.freeze(view), mutations }) as unknown as ScopeResult<O>;
    scopes.set(cacheKey, result);
    return result;
  }
  const store = Object.freeze({
    scope,
    subscribe(listener: (change: StateChange) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return store as StateStore;
}
