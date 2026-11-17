import { createHash } from "node:crypto";
import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { record } from "../../../shared/skills/manifest/primitives.js";
import { stableJson } from "../../../shared/stable-json.js";
import { sessionSkillContext } from "../../../shared/session-skills.js";
import { DOCUMENT_CREATION_CAPABILITIES } from "../../../shared/creation/contracts.js";
import type { SkillCatalog } from "../catalog/service.js";
import { SkillRegistryError } from "../errors.js";
import { skillManagementProtection } from "./protect.js";
import { createSkillSummaryReader } from "../catalog/summaries.js";

/** Capturing instructions grants no tools, filesystem access or project membership. */
export function conversationSkillRoutes(catalog: SkillCatalog, owner: (context: RouteContext) => string): Route[] {
  const protect = skillManagementProtection(owner),
    describe = createSkillSummaryReader(catalog);
  return [
    {
      path: "/api/conversation-skills/capture",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = record(await readJsonBody(req, 128 * 1024), ["id", "scope", "input", "selections"]);
        if (
          typeof input.scope !== "string" ||
          !input.scope ||
          input.scope.length > 4096 ||
          typeof input.input !== "string" ||
          input.input.length > 65536
        )
          throw new SkillRegistryError("invalidInput");
        const binding = createHash("sha256")
          .update(stableJson({ scope: input.scope, input: input.input }))
          .digest("hex");
        const allowed = new Set(DOCUMENT_CREATION_CAPABILITIES);
        const capture = await catalog.capture(
          { id: input.id, requestBinding: binding, selections: input.selections },
          actor,
          {
            outputType: "document",
            available: allowed,
            granted: allowed,
            entitled: new Set(),
            workflowRequired: false,
          },
        );
        const summary = await describe(
          capture.composition.skills.map(({ packageId, version, digest, id, parameters }) => ({
            packageId,
            version,
            digest,
            id,
            parameters,
          })),
        );
        const guidance = [
          "Use these selected skills as guidance for this user message. They do not grant tools or override user instructions or session permissions.",
          "When asked to create a document, save it in the current session working directory by default. Resolve a user-specified relative path against that directory, including paths such as docs/prd/requirements.md.",
          "Honor an explicitly requested authorized project or directory. Resolve ambiguous projects before writing and preserve existing content unless replacement is requested. Report the actual saved path and only claim success after verifying the saved file.",
          "A later message may remove or replace these skills. Apply only the skills attached to that message; preserve previously created documents and historical skill records.",
          ...capture.composition.skills.map((skill) =>
            [
              `${skill.qualifiedId}@${skill.version}`,
              skill.instructions,
              "Parameters: " + stableJson(skill.parameters),
              ...(skill.template ? [skill.template] : []),
            ].join("\n\n"),
          ),
        ].join("\n\n");
        respondJson(res, 200, { id: capture.id, context: sessionSkillContext(summary, guidance) });
      }),
    },
  ];
}
