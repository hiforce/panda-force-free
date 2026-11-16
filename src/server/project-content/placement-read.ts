import { ProjectContentError } from "./errors.js";
import type { ProjectGitSnapshots } from "./git/snapshot.js";
import {
  decodePlacementRecords,
  projectPlacementFile,
  type ProjectPlacementFile,
  type ProjectPlacementRecords,
} from "./placement-file.js";
import type { ProjectContentView } from "./read-view.js";
import { projectRecordShard } from "./record-shards.js";

function decode(bytes: Buffer | null, projectId: string, shard: string): ProjectPlacementRecords {
  const value: ProjectPlacementRecords =
    bytes === null ? { schema: 1, projectId, shard, placements: [] } : decodePlacementRecords(bytes);
  if (value.projectId !== projectId || value.shard !== shard) throw new ProjectContentError("invalidFile");
  return value;
}
export async function readPlacementShard(view: ProjectContentView, projectId: string, id: string) {
  return decode(await view.read(projectPlacementFile(id)), projectId, projectRecordShard(id));
}
export async function readPlacement(view: ProjectContentView, projectId: string, id: string) {
  return (
    (await readPlacementShard(view, projectId, id)).placements.find((record) => record.placement.id === id) ?? null
  );
}
/** Current records are bounded by the project read budget; immutable history is never hydrated by this scan. */
export async function readPlacementShards(view: ProjectContentView, projectId: string) {
  const records = new Map<string, ProjectPlacementRecords>();
  for (const path of view.paths.filter((path) => path.startsWith("placements/")).sort()) {
    const match = /^placements\/([a-f0-9]{2})\.panda\.json$/.exec(path);
    if (!match) throw new ProjectContentError("invalidFile");
    records.set(path, decode(await view.read(path), projectId, match[1]!));
  }
  return records;
}
export async function placementAt(
  snapshots: ProjectGitSnapshots,
  commit: string,
  projectId: string,
  id: string,
): Promise<ProjectPlacementFile> {
  const shard = decode(await snapshots.fileAt(commit, projectPlacementFile(id)), projectId, projectRecordShard(id)),
    value = shard.placements.find((record) => record.placement.id === id);
  if (!value) throw new ProjectContentError("notFound");
  return value;
}
