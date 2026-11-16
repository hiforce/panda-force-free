import { documentCreationWorkflow, creationExecutionSelections } from "./workflow.js";
import type { SkillCatalog } from "../../skills/catalog/service.js";
import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import type { CreationSubmissionAuthority } from "../submissions.js";
import type { CreationProfiles } from "./profiles.js";
import { DOCUMENT_CREATION_CAPABILITIES, type CreationAvailability } from "../../../shared/creation/contracts.js";
import type { SkillCapability } from "../../../shared/skills/contracts.js";
import { CreationError } from "../contracts.js";

const capabilities = DOCUMENT_CREATION_CAPABILITIES;
/** Declared capabilities match the actual tool set. Revision-oriented and paid skills keep their own unavailable states. */
export function creationAuthority(options: {
  authorize(owner: string, projectId: string): Promise<void>;
  documents: Pick<FileDocumentNavigation, "tree">;
  profiles: CreationProfiles;
  skills: SkillCatalog;
}) {
  const allowed = new Set<SkillCapability>(capabilities);
  const authority: CreationSubmissionAuthority = {
    authorize: options.authorize,
    async target(owner, input) {
      await options.authorize(owner, input.projectId);
      const tree = await options.documents.tree(input.projectId);
      if (
        tree.version < input.treeVersion ||
        (input.parentId !== null && !tree.nodes.some((node) => node.documentId === input.parentId))
      )
        throw new CreationError("conflict");
    },
    profile: (id) => options.profiles.resolve(id),
    capture: async (owner, input, requestDigest) =>
      options.skills.capture(
        {
          id: input.id,
          requestBinding: requestDigest,
          selections: await creationExecutionSelections(options.skills, input.selections),
        },
        owner,
        {
          outputType: "document",
          available: allowed,
          granted: allowed,
          entitled: new Set(),
        },
      ),
  };
  async function availability(): Promise<CreationAvailability> {
    const profiles = await options.profiles.list();
    const defaultWorkflow = await documentCreationWorkflow(options.skills);
    return { ...profiles, defaultWorkflow, capabilities };
  }
  return { authority, availability };
}
