import { isAbsolute } from "node:path";
import { LegacyProjectDocuments } from "../project-content/migration/legacy-documents.js";
import { planLegacyMetadata } from "../project-content/migration/metadata-plan.js";
import { openLegacyAssets } from "../project-content/migration/assets.js";
import { ProjectContentError } from "../project-content/errors.js";
import { stableJson } from "../../shared/stable-json.js";
import { inventoryLegacyProjectHistory } from "./history/inventory.js";
import { historyHash } from "./history/context.js";

/** Offline planning reads canonical originals, metadata, binaries and consumer history without opening any application. */
export async function planLegacyProjectCutover(input: { backup: string; projectId: string; assets?: string }) {
  const backup = input.backup,
    projectId = input.projectId,
    assetsPath = input.assets;
  if (!isAbsolute(backup) || (assetsPath !== undefined && !isAbsolute(assetsPath)))
    throw new ProjectContentError("invalidFile");
  const source = await LegacyProjectDocuments.open(backup, projectId);
  try {
    const originals = source.inventory(),
      metadata = planLegacyMetadata(source),
      history = inventoryLegacyProjectHistory(source);
    if (metadata.metadata.assets.length && !assetsPath) throw new ProjectContentError("invalidFile");
    const assets = assetsPath ? await openLegacyAssets(assetsPath) : null;
    for (const asset of metadata.metadata.assets) await assets!.read(asset);
    await assets?.verify();
    await source.assertSourceUnchanged();
    const plan = {
      schema: 1 as const,
      projectId,
      sourceHash: source.sourceHash,
      sourceSchema: source.schema,
      originals: originals.map(({ document, revisions, encodedBytes, historyHash }) => ({
        id: document.id,
        revisions,
        encodedBytes,
        historyHash,
      })),
      metadata: {
        spaces: metadata.metadata.spaces.length,
        assets: metadata.metadata.assets.length,
        folders: metadata.metadata.folders.length,
        generatedDirectoryDocuments: metadata.navigation.generated.length,
        placementEvents: metadata.metadata.placements.reduce((sum, row) => sum + row.events.length, 0),
      },
      history,
      status: history.blockers.length ? ("blocked" as const) : ("inventoried" as const),
      storageActivated: false as const,
      historyReconciled: false as const,
    };
    return { ...plan, digest: historyHash(stableJson(plan)) };
  } finally {
    source.close();
  }
}
