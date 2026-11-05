import manifest from "./state-contracts.json";

// Capability data is reviewed independently of the state implementation.
export const FIELD_DOMAINS = Object.freeze(manifest.fields);
export const STATE_CONTRACTS = Object.freeze(
  Object.fromEntries(
    Object.entries(manifest.features).map(([owner, contract]) => [
      owner,
      Object.freeze({ read: Object.freeze(contract.read), write: Object.freeze(contract.write) }),
    ]),
  ),
);
