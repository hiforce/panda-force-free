import { documentCreationWorkflow, creationExecutionSelections } from "./workflow.js";
import type { SkillCatalog } from "../../skills/catalog/service.js";
import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import type { CreationSubmissionAuthority } from "../submissions.js";
import type { CreationProfiles } from "./profiles.js";
import type { CreationAvailability } from "../../../shared/creation/contracts.js";
import type { SkillCapability } from "../../../shared/skills/contracts.js";
import { CreationError } from "../contracts.js";
import { creationCaptureCapabilities } from "./capabilities.js";

/** Declared capabilities match the actual tool set. Revision-oriented and paid skills keep their own unavailable states. */
export function creationAuthority(options: {
  authorize(owner: string, projectId: string): Promise<void>;
  documents: Pick<FileDocumentNavigation, "tree"> & { revisions?: import("../ports.js").CreationDocumentRevisions };
  profiles: CreationProfiles;
  skills: SkillCatalog;
  rendering?: import("../runtime/rendering.js").CreationRendering;
  original?: CreationSubmissionAuthority["original"];
}) {
  const authority: CreationSubmissionAuthority = {
    authorize: options.authorize,
    revision: options.documents.revisions?.read,
    original: options.original,
    async target(owner, input) {
      await options.authorize(owner, input.projectId);
      if (input.outputType !== undefined && input.outputType !== "document" && input.outputType !== "auto") {
        const types = (await options.rendering?.available()) ?? [];
        if (!types.includes(input.outputType) && !(input.runtimeId && options.rendering))
          throw new CreationError("unavailable");
      }
      if (input.previousTaskId) return;
      const tree = await options.documents.tree(input.projectId);
      if (
        tree.version < input.treeVersion ||
        (input.parentId !== null && !tree.nodes.some((node) => node.documentId === input.parentId))
      )
        throw new CreationError("conflict");
    },
    profile: (id, selection, owner) => options.profiles.resolve(id, selection, owner),
    capture: async (owner, input, requestDigest) => {
      const allowed = new Set<SkillCapability>(
        creationCaptureCapabilities(input.outputType, (await options.rendering?.available()) ?? []),
      );
      return options.skills.capture(
        {
          id: input.id,
          requestBinding: requestDigest,
          selections:
            input.outputType === undefined
              ? await creationExecutionSelections(options.skills, input.selections)
              : input.selections,
        },
        owner,
        {
          outputType: input.outputType && input.outputType !== "auto" ? input.outputType : "document",
          ...(input.outputType === undefined ? {} : { guidanceOnly: true, workflowRequired: false }),
          available: allowed,
          granted: allowed,
          entitled: new Set(),
        },
      );
    },
  };
  async function availability(): Promise<CreationAvailability> {
    const profiles = await options.profiles.list();
    const defaultWorkflow = await documentCreationWorkflow(options.skills);
    const outputTypes = ["document" as const, ...((await options.rendering?.available()) ?? [])];
    return {
      ...profiles,
      defaultWorkflow,
      capabilities: creationCaptureCapabilities("auto", outputTypes),
      outputTypes,
    };
  }
  return { authority, availability };
}
