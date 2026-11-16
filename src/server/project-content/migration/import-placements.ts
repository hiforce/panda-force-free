import type { ProjectContentProject } from "../project.js";
import type { ContentAuthor } from "../git/process.js";
import type { LegacyPlacementHistory } from "./legacy-placements.js";
import { placementCommitMessage } from "../placement-history.js";
import { readPlacementShard } from "../placement-read.js";
import { encodePlacementRecords, projectPlacementFile } from "../placement-file.js";
import { ProjectContentError } from "../errors.js";
import { contentRequestHash } from "../mutation.js";
import { stableJson } from "../../../shared/stable-json.js";
import { legacyImportOperation } from "./write-metadata.js";

/** Replay prevalidated events without reapplying current policy or incrementing already-preserved space versions. */
export async function importLegacyPlacementHistory(
  project: ProjectContentProject,
  sourceHash: string,
  histories: readonly LegacyPlacementHistory[],
  author: ContentAuthor,
) {
  for (const history of histories) {
    for (const [index, value] of history.events.entries()) {
      await project.coordinator.transact(
        {
          operationId: legacyImportOperation(sourceHash, "placement-event", {
            id: value.placement.id,
            version: value.placement.version,
          }),
          author,
          message: placementCommitMessage(value),
          intent: contentRequestHash(value),
        },
        async (view) => {
          const shard = await readPlacementShard(view, project.owned.projectId, value.placement.id),
            previous = shard.placements.find((row) => row.placement.id === value.placement.id);
          if (index === 0 ? previous !== undefined : stableJson(previous) !== stableJson(history.events[index - 1]))
            throw new ProjectContentError("conflict");
          return [
            {
              path: projectPlacementFile(value.placement.id),
              content: encodePlacementRecords({
                ...shard,
                placements: [...shard.placements.filter((row) => row.placement.id !== value.placement.id), value].sort(
                  (a, b) => a.placement.id.localeCompare(b.placement.id, "en"),
                ),
              }),
            },
          ];
        },
      );
    }
  }
}
