import { request } from "./http-client.js";
import { errorText } from "./i18n.js";
import type { Translate } from "../shared/i18n/messages.js";
import type { NativeInput } from "../shared/data-contracts.js";
import type { CreationSkillSelection } from "../shared/creation/contracts.js";
import { sessionSkillContext } from "../shared/session-skills.js";
import { isRecord } from "../shared/records.js";

/** Freeze each explicit submission independently of subsequent picker edits. */
export async function prepareSessionSkillInput(
  input: readonly NativeInput[],
  selections: readonly CreationSkillSelection[],
  scope: string,
  t: Translate,
) {
  if (!selections.length)
    return [
      ...input,
      {
        type: "text" as const,
        text: sessionSkillContext(
          [],
          "No skills are selected for this message. Earlier skill guidance does not apply to this message; preserve existing documents.",
        ),
      },
    ];
  const response = await request("/api/conversation-skills/capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ id: crypto.randomUUID(), scope, input: JSON.stringify(input), selections }),
  });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || typeof value.context !== "string")
    throw new Error(errorText(value, t, "skills.unavailable"));
  return [...input, { type: "text" as const, text: value.context }];
}
