import type { Translate } from "../../src/shared/i18n/messages.js";
import type { FeatureOptions, ApplicationPorts } from "../../src/client/application/ports.js";
import type { NativeInput, HistoryQuery } from "../../src/shared/data-contracts.js";
import { createConversationCache } from "../../src/client/conversation-cache.js";
import { requireElement } from "../../src/client/dom.js";

declare const t: Translate;
declare const options: FeatureOptions<"t", "submission">;
t("common.logIn");
t("plugin.example.greeting", { name: "User" });
t("usage.resetsInDaysdHourshMinutesm", { days: 1, hours: 2, minutes: 3 });
// @ts-expect-error Unknown product message IDs are rejected.
t("common.missingMessage");
// @ts-expect-error Required ICU parameters cannot be omitted.
t("usage.resetsInDaysdHourshMinutesm");
// @ts-expect-error Numeric ICU values cannot be passed as strings.
t("usage.resetsInDaysdHourshMinutesm", { days: "one", hours: 2, minutes: 3 });
// @ts-expect-error Peer interfaces reject methods that do not exist.
options.submissionPort.sendWhatever();
// @ts-expect-error Questionnaire submission requires a conversation identity.
options.submissionPort.submitPrompt({ preventDefault() {} }, { text: "answer" });
// @ts-expect-error Local image inputs require a path.
const invalidInput: NativeInput = { type: "localImage", url: "https://example.org/image.png" };
// @ts-expect-error History limits must be numeric.
const invalidQuery: HistoryQuery = { threadId: "example", limit: "20" };
// @ts-expect-error Cache identities are immutable strings supplied by authentication.
createConversationCache({ identity: 123 });
requireElement("#prompt").value = "Hello";
// @ts-expect-error Stable interface selectors preserve their actual element types.
requireElement("#prompt").href = "/unexpected";
void invalidInput;
void invalidQuery;

// Every feature interface must reject undeclared properties, including inferred JavaScript returns.
type AssertNever<T extends never> = T;
type OpenPorts = {
  [K in keyof ApplicationPorts]: string extends keyof ApplicationPorts[K] ? K : never;
}[keyof ApplicationPorts];
export type AllPortsAreClosed = AssertNever<OpenPorts>;
declare const sidebar: ApplicationPorts["sidebar"];
// @ts-expect-error Inferred JavaScript objects must not silently accept unknown port members.
sidebar.missingMethod();

import { createFeaturePort, installFeature } from "../../src/client/application/composition.js";
const strictPort = createFeaturePort<{ submit(text: string): void }>("typed");
installFeature(strictPort, {
  // @ts-expect-error Installing a mismatched implementation cannot widen the declared port.
  submit(count: number) {
    void count;
  },
});
