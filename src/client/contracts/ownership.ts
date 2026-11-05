import type { DataView } from "../../shared/data-view.js";
import type { StateMutations } from "./mutations.js";
import type { ApplicationState } from "./state.js";
import type { ReadFields, StateOwner, WriteFields } from "./state-grants.js";

export type StateReader<O extends StateOwner> = DataView<Pick<ApplicationState, ReadFields<O>>>;
export type StateWriter<O extends StateOwner> = StateMutations<Pick<ApplicationState, WriteFields<O>>>;
export interface StateScope<O extends StateOwner> {
  readonly state: StateReader<O>;
  readonly mutations: StateWriter<O>;
}
export interface StateChange {
  readonly domain: string;
  readonly field: keyof ApplicationState;
}
export interface StateStore {
  scope<O extends StateOwner>(owner: O, options?: { testing?: false }): StateScope<O>;
  scope(
    owner: "diagnostics",
    options: { testing: true },
  ): {
    readonly state: DataView<ApplicationState>;
    readonly mutations: StateMutations<ApplicationState>;
  };
  subscribe(listener: (change: StateChange) => void): () => void;
}
