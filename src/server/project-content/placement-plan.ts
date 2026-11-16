import { stableJson } from "../../shared/stable-json.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import type { ProjectContentView } from "./read-view.js";
import { ProjectContentError } from "./errors.js";
import { projectSpaceFile } from "./paths.js";
import {
  decodeProjectPlacement,
  encodeProjectPlacement,
  encodePlacementRecords,
  projectPlacementFile,
  type ProjectPlacementFile,
} from "./placement-file.js";
import { readPlacementShards } from "./placement-read.js";
import { placementAvailable, placementScope } from "./placement-policy.js";
import { projectRecordShard } from "./record-shards.js";
import { encodeProjectSpace } from "./space-file.js";

export function placementInput(
  owned: OwnedProjectDirectory,
  input: ProjectPlacementFile,
  expectedVersion: number | null,
  expectedSpaceVersion?: number,
) {
  const value = decodeProjectPlacement(encodeProjectPlacement(input)),
    placement = value.placement;
  if (
    placement.projectId !== owned.projectId ||
    (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) ||
    (expectedSpaceVersion !== undefined && (!Number.isSafeInteger(expectedSpaceVersion) || expectedSpaceVersion < 1)) ||
    placement.version !== (expectedVersion ?? 0) + 1
  )
    throw new ProjectContentError("invalidFile");
  return value;
}

/** A prepared placement and its destination version share the caller's project lease and commit. */
export async function prepareProjectPlacement(
  owned: OwnedProjectDirectory,
  view: ProjectContentView,
  input: ProjectPlacementFile,
  expectedVersion: number | null,
  expectedSpaceVersion?: number,
) {
  const value = placementInput(owned, input, expectedVersion, expectedSpaceVersion),
    placement = value.placement;
  const shards = await readPlacementShards(view, owned.projectId),
    path = projectPlacementFile(placement.id),
    shard = shards.get(path) ?? {
      schema: 1 as const,
      projectId: owned.projectId,
      shard: projectRecordShard(placement.id),
      placements: [],
    },
    previous = shard.placements.find((record) => record.placement.id === placement.id)?.placement;
  if (
    expectedVersion === null
      ? !!previous
      : !previous || previous.deletedAt !== null || previous.version !== expectedVersion
  )
    throw new ProjectContentError("conflict");
  if (
    previous &&
    ["projectId", "documentId", "spaceId", "createdAt"].some(
      (key) => Reflect.get(previous, key) !== Reflect.get(placement, key),
    )
  )
    throw new ProjectContentError("conflict");
  if (
    previous &&
    value.audit.operation === "remove" &&
    ["path", "locale", "revisionId", "metadata"].some(
      (key) => stableJson(Reflect.get(previous, key)) !== stableJson(Reflect.get(placement, key)),
    )
  )
    throw new ProjectContentError("conflict");
  const { target, trash } = await placementScope(view, owned, placement);
  if (expectedSpaceVersion !== undefined && target.space.version !== expectedSpaceVersion)
    throw new ProjectContentError("conflict");
  if (placement.deletedAt === null)
    await placementAvailable(
      view,
      placement,
      [...shards.values()].flatMap((record) => record.placements.map((entry) => entry.placement)),
      trash,
    );
  return [
    {
      path,
      content: encodePlacementRecords({
        ...shard,
        placements: [...shard.placements.filter((entry) => entry.placement.id !== placement.id), value].sort((a, b) =>
          a.placement.id.localeCompare(b.placement.id, "en"),
        ),
      }),
    },
    {
      path: projectSpaceFile(placement.spaceId),
      content: encodeProjectSpace({
        ...target,
        space: {
          ...target.space,
          version: target.space.version + 1,
          updatedAt: Math.max(target.space.updatedAt, placement.updatedAt, value.audit.createdAt),
        },
      }),
    },
  ];
}
