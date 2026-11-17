import type { CreationArtifactWriter, CreationOutputContent } from "../ports.js";
import type { CreationTaskSpec } from "../contracts.js";
import type { CreationDocumentArchive } from "./document-archive.js";

/** The task completes after its document, portable file and requested ownership transfer all have receipts. */
export function archivedCreationOutput(
  workspace: CreationArtifactWriter & CreationOutputContent,
  source: { read(digest: string): Promise<Parameters<CreationDocumentArchive["commit"]>[2]> },
  archive?: CreationDocumentArchive,
): CreationArtifactWriter & CreationOutputContent {
  return {
    stage: (value, task) => workspace.stage(value, task),
    commit: async (task: CreationTaskSpec, digest: string) => {
      const artifact = await workspace.commit(task, digest);
      return archive ? archive.commit(task, artifact, await source.read(digest)) : artifact;
    },
  };
}
