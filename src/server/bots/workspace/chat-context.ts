import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import type { BotChatSubmission } from "../../../shared/bots/workspace.js";
import type { CreationMaterial } from "../../../shared/creation/contracts.js";
import type { SkillComposition } from "../../../shared/skills/composition.js";
import type { SessionSkillSummary } from "../../../shared/session-skills.js";
import type { CreationMaterialPort } from "../../creation/materials.js";
import type { SkillCatalog } from "../../skills/catalog/service.js";
import { createSkillSummaryReader } from "../../skills/catalog/summaries.js";
import { DOCUMENT_CREATION_CAPABILITIES } from "../../../shared/creation/contracts.js";

export interface BotChatContext {
  materials: CreationMaterial[];
  skills: SkillComposition | null;
  summaries: SessionSkillSummary[];
}
export interface BotChatContextPort {
  prepare(owner: string, botId: string, input: BotChatSubmission): Promise<BotChatContext>;
  read: CreationMaterialPort["read"];
}

/** Reuse conversation skill guidance; the chat executor exposes no project-write or external-action tools. */
export function botChatContext(
  materials: CreationMaterialPort,
  catalog: Pick<SkillCatalog, "capture" | "detail">,
): BotChatContextPort {
  const summarize = createSkillSummaryReader(catalog);
  return {
    async prepare(owner, botId, input) {
      const files = await materials.prepare(owner, input.attachments ?? []);
      if (!input.selections?.length) return { materials: files, skills: null, summaries: [] };
      const capture = await catalog.capture(
        {
          id: input.requestId,
          requestBinding: createHash("sha256")
            .update(stableJson({ botId, ...input }))
            .digest("hex"),
          selections: input.selections,
        },
        owner,
        {
          outputType: "document",
          available: new Set(DOCUMENT_CREATION_CAPABILITIES),
          granted: new Set(DOCUMENT_CREATION_CAPABILITIES),
          entitled: new Set(),
          workflowRequired: false,
        },
      );
      if (Buffer.byteLength(stableJson(capture.composition)) > 90000) throw new Error("Bot guidance too large");
      return { materials: files, skills: capture.composition, summaries: await summarize(input.selections) };
    },
    read: (owner, material, offset, locale) => materials.read(owner, material, offset, locale),
  };
}
