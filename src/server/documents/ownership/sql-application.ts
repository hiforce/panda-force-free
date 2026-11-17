import type { DocumentSpace } from "../../../shared/documents/contracts.js";
import type { ProjectDocumentTree } from "../../../shared/documents/navigation.js";
import type { OwnershipSQLBatch } from "./sql-batch.js";
import { SQLDocumentOwnershipSource } from "./sql-source.js";
import { SQLDocumentOwnershipRemoval } from "./sql-removal.js";
import { SQLDocumentOwnershipTarget } from "./sql-target.js";
import { SQLDocumentOwnershipImages } from "./sql-images.js";
import { sqlOwnershipLocation } from "./location.js";

/** These internal ports use the installation's selected library, transaction and original image directory. */
export function createSQLDocumentOwnershipTransfers(options: {
  batch: OwnershipSQLBatch;
  assetRoot: string;
  library: { ensure(project: string, locale: string): DocumentSpace | Promise<DocumentSpace> };
  navigation: { tree(project: string): ProjectDocumentTree | Promise<ProjectDocumentTree> };
  authorize(project: string): unknown | Promise<unknown>;
}) {
  const { batch } = options,
    images = new SQLDocumentOwnershipImages(options.assetRoot),
    authorize = async (project: string) => {
      await options.authorize(project);
    },
    source = new SQLDocumentOwnershipSource(
      batch,
      (project) => options.navigation.tree(project),
      (asset) => images.read(asset),
      authorize,
    ),
    removal = new SQLDocumentOwnershipRemoval(batch, authorize),
    target = new SQLDocumentOwnershipTarget(
      batch,
      async (project, locale) => {
        await authorize(project);
        const space = await options.library.ensure(project, locale);
        await options.navigation.tree(project);
        await authorize(project);
        return space;
      },
      authorize,
      (asset, bytes) => images.write(asset, bytes),
      (asset) => images.read(asset),
    );
  return {
    batch,
    source,
    removal,
    target,
    location: (project: string, documentId: string) => sqlOwnershipLocation(batch, project, documentId),
  };
}
