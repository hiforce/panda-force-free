import type { DocumentPlacementEvent } from "../../shared/documents/placements.js";
import { stableJson } from "../../shared/stable-json.js";
import type { ProjectContentCoordinator } from "./coordinator.js";
import { ProjectContentError } from "./errors.js";
import type { ContentAuthor } from "./git/process.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { contentRequestHash } from "./mutation.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { projectContentId } from "./paths.js";
import { type ProjectPlacementFile } from "./placement-file.js";
import {
  ProjectPlacementHistory,
  placementCommitMessage,
  placementEventSummary,
  type ProjectPlacementHistoryEntry,
} from "./placement-history.js";
import { placementAt, readPlacement, readPlacementShards } from "./placement-read.js";
import type { ProjectContentView } from "./read-view.js";
import { placementInput, prepareProjectPlacement } from "./placement-plan.js";

/** Placements reference saved originals. Current records, destination versions and event history commit atomically. */
export class ProjectPlacementFiles {
  private readonly snapshots: ProjectGitSnapshots;
  private readonly historyReader: ProjectPlacementHistory;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
    this.historyReader = new ProjectPlacementHistory(owned);
  }
  async get(id: string): Promise<ProjectPlacementFile | null> {
    projectContentId(id);
    return this.coordinator.view((view) => readPlacement(view, this.owned.projectId, id));
  }
  async list(kind: "documentId" | "spaceId", id: string) {
    projectContentId(id);
    if (!["documentId", "spaceId"].includes(kind)) throw new ProjectContentError("invalidFile");
    return this.coordinator.view(async (view) =>
      [...(await readPlacementShards(view, this.owned.projectId)).values()]
        .flatMap((shard) => shard.placements.map((record) => record.placement))
        .filter((record) => record[kind] === id && record.deletedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en")),
    );
  }
  async put(
    input: ProjectPlacementFile,
    expectedVersion: number | null,
    operationId: string,
    author: ContentAuthor,
    expectedSpaceVersion?: number,
  ) {
    const value = placementInput(this.owned, input, expectedVersion, expectedSpaceVersion),
      placement = value.placement;
    const result = await this.coordinator.transact(
      {
        operationId,
        author,
        message: placementCommitMessage(value),
        intent: stableJson({
          schema: 1,
          kind: "placement-put",
          recordHash: contentRequestHash(value),
          expectedVersion,
          ...(expectedSpaceVersion === undefined ? {} : { expectedSpaceVersion }),
        }),
      },
      async (view) => {
        return this.prepare(view, value, expectedVersion, expectedSpaceVersion);
      },
    );
    return placementAt(this.snapshots, result.commit, this.owned.projectId, placement.id);
  }
  prepare(
    view: ProjectContentView,
    value: ProjectPlacementFile,
    expectedVersion: number | null,
    expectedSpaceVersion?: number,
  ) {
    return prepareProjectPlacement(this.owned, view, value, expectedVersion, expectedSpaceVersion);
  }
  async historyIn(view: ProjectContentView, id: string, limit = 100) {
    return (await this.entriesIn(view, id, limit)).map((entry) => entry.summary);
  }
  private async entries(id: string, limit: number, version?: number): Promise<ProjectPlacementHistoryEntry[]> {
    projectContentId(id);
    return this.coordinator.view((view) => this.entriesIn(view, id, limit, version));
  }
  private async entriesIn(
    view: ProjectContentView,
    id: string,
    limit: number,
    version?: number,
  ): Promise<ProjectPlacementHistoryEntry[]> {
    projectContentId(id);
    view.assertHeld();
    const current = await readPlacement(view, this.owned.projectId, id);
    if (!current) throw new ProjectContentError("notFound");
    const latest = await this.historyReader.list(id, view.commit, 1);
    if (latest.length !== 1 || stableJson(latest[0]!.summary) !== stableJson(placementEventSummary(current)))
      throw new ProjectContentError("invalidFile");
    const result =
      version === undefined && limit === 1 ? latest : await this.historyReader.list(id, view.commit, limit, version);
    view.assertHeld();
    return result;
  }

  async history(id: string, limit = 100) {
    return (await this.entries(id, limit)).map((entry) => entry.summary);
  }
  async event(id: string, version: number): Promise<DocumentPlacementEvent> {
    return this.coordinator.view((view) => this.eventIn(view, id, version));
  }
  async eventIn(view: ProjectContentView, id: string, version: number): Promise<DocumentPlacementEvent> {
    const rows = await this.entriesIn(view, id, 2, version);
    if (rows.length !== 1) throw new ProjectContentError("notFound");
    const entry = rows[0]!,
      value = await placementAt(this.snapshots, entry.commit, this.owned.projectId, id);
    if (value.placement.version !== version || stableJson(placementEventSummary(value)) !== stableJson(entry.summary))
      throw new ProjectContentError("invalidFile");
    view.assertHeld();
    return { placement: value.placement, ...value.audit };
  }
}
