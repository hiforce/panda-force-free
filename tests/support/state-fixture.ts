import { createStateDomains } from "../../src/client/application/state-domains.js";
import type { StateMutations } from "../../src/client/application/state-mutations.js";
import type { DataView } from "../../src/shared/read-model.js";

/** Component tests use the same ownership and immutable reads as the application. */
export function createStateFixture<S extends Record<string, unknown>>(initial: S) {
  const domains = createStateDomains(initial);
  const capability = domains.scope("diagnostics", { testing: true });
  return {
    domains,
    state: capability.state as DataView<S>,
    mutations: capability.mutations as StateMutations<S>,
  };
}
