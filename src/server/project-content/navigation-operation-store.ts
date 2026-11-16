import { stableJson } from "../../shared/stable-json.js";
import { ProjectContentCoordinator } from "./coordinator.js";
import { readProjectDocumentMetadata } from "./document-metadata.js";
import { ProjectContentError } from "./errors.js";
import type { ContentAuthor } from "./git/process.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { PROJECT_CONTENT_LIMITS } from "./limits.js";
import { contentRequestHash } from "./mutation.js";
import {
  decodeNavigationOperation,
  decodeNavigationOperations,
  encodeNavigationOperations,
  navigationOperationFile,
  navigationOperationShard,
  type ProjectNavigationOperation,
  type ProjectNavigationOperationFile,
} from "./navigation-operation-file.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { projectContentId } from "./paths.js";
import { readProjectManifest } from "./project-manifest.js";
import type { ProjectContentView } from "./read-view.js";

/** Reservation identity and immutable completion receipts share the project's file transaction. */
export class ProjectNavigationOperationFiles {
  private readonly snapshots: ProjectGitSnapshots;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
  }
  private async shard(view: ProjectContentView, id: string): Promise<ProjectNavigationOperationFile> {
    const bytes = await view.read(navigationOperationFile(id)),
      shard = navigationOperationShard(id),
      value: ProjectNavigationOperationFile =
        bytes === null
          ? { schema: 1, projectId: this.owned.projectId, shard, operations: [] }
          : decodeNavigationOperations(bytes);
    if (value.projectId !== this.owned.projectId || value.shard !== shard) throw new ProjectContentError("invalidFile");
    return value;
  }
  async get(id: string): Promise<ProjectNavigationOperation | null> {
    projectContentId(id);
    return this.coordinator.view((view) => this.lookup(view, id));
  }
  async lookup(view: ProjectContentView, id: string): Promise<ProjectNavigationOperation | null> {
    projectContentId(id);
    return (await this.shard(view, id)).operations.find((operation) => operation.id === id) ?? null;
  }
  private transition(previous: ProjectNavigationOperation, next: ProjectNavigationOperation): void {
    const { result: oldResult, ...oldIdentity } = previous,
      { result: newResult, ...newIdentity } = next;
    if (
      stableJson(oldIdentity) !== stableJson(newIdentity) ||
      (oldResult !== null && stableJson(oldResult) !== stableJson(newResult))
    )
      throw new ProjectContentError("conflict");
  }
  /** Several reservations in one shard are merged once; a caller may compose this plan with other metadata plans. */
  async prepareMany(view: ProjectContentView, input: readonly ProjectNavigationOperation[]) {
    if (input.length > PROJECT_CONTENT_LIMITS.files) throw new ProjectContentError("invalidFile");
    const values = input.map(decodeNavigationOperation),
      manifest = await readProjectManifest(view, this.owned.projectId),
      ids = new Set<string>(),
      shards = new Map<
        string,
        { value: ProjectNavigationOperationFile; operations: Map<string, ProjectNavigationOperation> }
      >();
    for (const operation of values) {
      if (ids.has(operation.id)) throw new ProjectContentError("invalidFile");
      ids.add(operation.id);
      if (!manifest.spaceIds.includes(operation.spaceId)) throw new ProjectContentError("invalidFile");
      const shardId = navigationOperationShard(operation.id);
      let shard = shards.get(shardId);
      if (!shard) {
        const value = await this.shard(view, operation.id);
        shard = { value, operations: new Map(value.operations.map((record) => [record.id, record])) };
        shards.set(shardId, shard);
      }
      const previous = shard.operations.get(operation.id);
      if (previous) this.transition(previous, operation);
      if (operation.result !== null) {
        for (const id of operation.result.affectedDocumentIds) {
          const { document } = await readProjectDocumentMetadata(view, id);
          if (document.spaceId !== operation.spaceId) throw new ProjectContentError("invalidFile");
        }
      }
      shard.operations.set(operation.id, operation);
    }
    return [...shards]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([id, shard]) => ({
        path: "navigation-operations/" + id + ".panda.json",
        content: encodeNavigationOperations({
          ...shard.value,
          operations: [...shard.operations.values()].sort((a, b) => a.id.localeCompare(b.id, "en")),
        }),
      }));
  }
  async put(input: ProjectNavigationOperation, operationId: string, author: ContentAuthor) {
    const operation = decodeNavigationOperation(input),
      result = await this.coordinator.transact(
        {
          operationId,
          author,
          message: "Record document tree operation",
          intent: stableJson({ schema: 1, kind: "navigation-operation", recordHash: contentRequestHash(operation) }),
        },
        (view) => this.prepareMany(view, [operation]),
      );
    const bytes = await this.snapshots.fileAt(result.commit, navigationOperationFile(operation.id));
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const file = decodeNavigationOperations(bytes),
      stored = file.operations.find((record) => record.id === operation.id);
    if (file.projectId !== this.owned.projectId || file.shard !== navigationOperationShard(operation.id) || !stored)
      throw new ProjectContentError("invalidFile");
    return stored;
  }
}
