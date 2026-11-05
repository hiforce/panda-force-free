import type { StateScope } from "../../src/client/contracts/ownership.js";
import type { OwnedStateField } from "../../src/client/contracts/state-grants.js";
import type { ApplicationState } from "../../src/client/contracts/state.js";
import type { ApplicationPorts } from "../../src/client/application/ports.js";
type Never<T extends never> = T;
export type AllStateFieldsOwned = Never<Exclude<keyof ApplicationState, OwnedStateField>>;
export type AllOwnedFieldsExist = Never<Exclude<OwnedStateField, keyof ApplicationState>>;
declare const composer: StateScope<"composer">;
// @ts-expect-error Composer cannot mutate transport or configuration state.
composer.mutations.set("config", { home: "/unexpected", defaultCwd: "/unexpected", projectless: false });
// @ts-expect-error Readers cannot write nested session records.
composer.state.active!.name = "bypass";
// @ts-expect-error The active conversation is owned by the session repository.
composer.mutations.edit("active", () => {});
declare const activity: StateScope<"activity">;
// @ts-expect-error Read-only maps never expose native writers.
activity.state.activityItems.clear();
// @ts-expect-error Capability writers preserve the domain record type.
activity.mutations.collection("activityItems").set("turn", "wrong");
declare const transport: ApplicationPorts["transport"];
// @ts-expect-error Unknown RPC names cannot return unconstrained results.
transport.rpc("do/whatever");
// @ts-expect-error Starting a turn returns a turn result, not a session list.
transport.rpc("turn/start").then((value) => value.data);
