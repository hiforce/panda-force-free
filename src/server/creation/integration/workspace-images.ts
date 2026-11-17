import { join } from "node:path";
import type { CreationTaskSpec } from "../contracts.js";
import { CreationError } from "../contracts.js";
import { creationUuidFromDigest } from "../validation.js";
import { CreationAuthoredFiles, type CreationFileDirectory } from "./authored-files.js";
import { openCreationDirectory } from "./conversation-directory.js";
import { workspaceExportHash, type CreationWorkspaceExport } from "./workspace-export-plan.js";

/** Each physical destination has its own exclusive image receipts; a filename alone never establishes ownership. */
export async function writeWorkspaceImages(
  root: string,
  task: CreationTaskSpec,
  plan: CreationWorkspaceExport,
  parent: CreationFileDirectory,
  originalDirectory: string,
  read: (digest: string) => Promise<Uint8Array>,
) {
  if (!plan.images.length) return;
  const images = new CreationAuthoredFiles(
      parent.path === originalDirectory
        ? join(root, "files")
        : join(root, "relocated-images", workspaceExportHash(parent.path)),
    ),
    directory = await openCreationDirectory(
      parent.path,
      "creation-assets-" + plan.conversationId,
      { owner: task.owner, conversationId: plan.conversationId, kind: "document-images" },
      true,
    );
  if (!directory) throw new CreationError("unavailable");
  for (const image of plan.images) {
    const id = creationUuidFromDigest(
      workspaceExportHash(
        JSON.stringify({ owner: task.owner, conversation: plan.conversationId, image: image.digest }),
      ),
    );
    await images.writeImage(
      task.owner,
      id,
      {
        path: directory.path,
        verify: async () => {
          await parent.verify();
          await directory.verify();
        },
      },
      image.digest + "." + image.extension,
      await read(image.digest),
    );
  }
}
