import { stableJson } from "../../shared/stable-json.js";
import { contentRequestHash } from "./mutation.js";
import type { ContentAuthor } from "./git/process.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { ProjectContentError } from "./errors.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { ProjectContentCoordinator } from "./coordinator.js";
import { readProjectManifest } from "./project-manifest.js";
import type { ProjectContentView } from "./read-view.js";
import { readProjectDocumentMetadata } from "./document-metadata.js";
import {
  decodeNavigationState,
  decodeProjectNavigation,
  encodeProjectNavigation,
  type ProjectNavigationFile,
  type ProjectNavigationState,
} from "./navigation-file.js";
import { projectContentId } from "./paths.js";

/** Navigation and original files share a coordination owner; this repository never owns source bodies. */
export class ProjectNavigationFiles {
  private readonly snapshots: ProjectGitSnapshots;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
  }
  private async read(view: ProjectContentView) {
    const manifest = await readProjectManifest(view, this.owned.projectId),
      bytes = await view.read("tree.json"),
      file: ProjectNavigationFile =
        bytes === null ? { schema: 1, projectId: this.owned.projectId, spaces: [] } : decodeProjectNavigation(bytes);
    if (
      file.projectId !== this.owned.projectId ||
      file.spaces.some((state) => !manifest.spaceIds.includes(state.spaceId))
    )
      throw new ProjectContentError("invalidFile");
    return { manifest, file };
  }
  async get(spaceId: string): Promise<ProjectNavigationState | null> {
    projectContentId(spaceId);
    return this.coordinator.view(async (view) => {
      const { manifest, file } = await this.read(view);
      if (!manifest.spaceIds.includes(spaceId)) throw new ProjectContentError("notFound");
      return file.spaces.find((state) => state.spaceId === spaceId) ?? null;
    });
  }
  async put(
    input: ProjectNavigationState,
    expectedVersion: number | null,
    operationId: string,
    author: ContentAuthor,
  ): Promise<ProjectNavigationState> {
    const value = decodeNavigationState(input);
    const result = await this.coordinator.transact(
      {
        operationId,
        author,
        message: "Save project navigation metadata",
        intent: stableJson({
          schema: 1,
          kind: "navigation-put",
          valueHash: contentRequestHash(value),
          expectedVersion,
        }),
      },
      async (view) => {
        return this.prepare(view, value, expectedVersion, operationId);
      },
    );
    const bytes = await this.snapshots.fileAt(result.commit, "tree.json");
    if (bytes === null) throw new ProjectContentError("invalidFile");
    const state = decodeProjectNavigation(bytes).spaces.find((state) => state.spaceId === value.spaceId);
    if (!state) throw new ProjectContentError("invalidFile");
    return state;
  }
  async prepare(
    view: ProjectContentView,
    input: ProjectNavigationState,
    expectedVersion: number | null,
    operationId: string,
  ) {
    const value = decodeNavigationState(input);
    if (
      (expectedVersion !== null &&
        (!Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0 ||
          value.version !== expectedVersion + 1 ||
          value.lastOperation?.id !== operationId)) ||
      (value.lastOperation !== null && value.lastOperation.id !== operationId)
    )
      throw new ProjectContentError("invalidFile");
    const { manifest, file } = await this.read(view),
      previous = file.spaces.find((state) => state.spaceId === value.spaceId);
    if (!manifest.spaceIds.includes(value.spaceId)) throw new ProjectContentError("notFound");
    if (expectedVersion === null ? !!previous : previous?.version !== expectedVersion)
      throw new ProjectContentError("conflict");
    const ids = new Set([...value.nodes, ...value.trash, ...value.origins].map((entry) => entry.documentId));
    for (const id of value.lastOperation?.affectedDocumentIds || []) ids.add(id);
    for (const id of ids) {
      const { document } = await readProjectDocumentMetadata(view, id);
      if (document.spaceId !== value.spaceId) throw new ProjectContentError("invalidFile");
    }
    return [
      {
        path: "tree.json",
        content: encodeProjectNavigation({
          ...file,
          spaces: [...file.spaces.filter((state) => state.spaceId !== value.spaceId), value].sort((a, b) =>
            a.spaceId.localeCompare(b.spaceId, "en"),
          ),
        }),
      },
    ];
  }
}
