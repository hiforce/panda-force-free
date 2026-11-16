import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import { contentRequestHash } from "./mutation.js";
import type { ContentAuthor } from "./git/process.js";
import { ProjectGitSnapshots } from "./git/snapshot.js";
import { ProjectContentError } from "./errors.js";
import type { OwnedProjectDirectory } from "./owned-directory.js";
import { projectContentId, projectSpaceFile } from "./paths.js";
import { ProjectContentCoordinator } from "./coordinator.js";
import { decodeProjectSpace, encodeProjectSpace, type ProjectSpaceFile } from "./space-file.js";
import { readProjectManifest, encodeProjectManifest } from "./project-manifest.js";
import { readSpaceMetadata, assertSpaceMembership } from "./space-read.js";
import type { ProjectContentView } from "./read-view.js";

/** Space and library membership share the project's transaction owner with source and navigation. */
export class ProjectSpaceFiles {
  private readonly snapshots: ProjectGitSnapshots;
  constructor(
    private readonly owned: OwnedProjectDirectory,
    private readonly coordinator: ProjectContentCoordinator,
  ) {
    this.snapshots = new ProjectGitSnapshots(owned);
  }

  private async records(view: ProjectContentView) {
    const manifest = await readProjectManifest(view, this.owned.projectId),
      records: DocumentSpace[] = [];
    const codes = new Set<string>();
    for (const id of manifest.spaceIds) {
      const space = await readSpaceMetadata(view, manifest, id);
      if (codes.has(space.code.toLowerCase())) throw new ProjectContentError("invalidFile");
      codes.add(space.code.toLowerCase());
      records.push(space);
    }
    return { manifest, records };
  }
  async list() {
    return this.coordinator.view(async (view) => {
      const { manifest, records } = await this.records(view);
      return records
        .filter((space) => space.id !== manifest.librarySpaceId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en"));
    });
  }
  async library() {
    return this.coordinator.view(async (view) => {
      const manifest = await readProjectManifest(view, this.owned.projectId);
      return manifest.librarySpaceId === null ? null : readSpaceMetadata(view, manifest, manifest.librarySpaceId);
    });
  }
  async get(id: string): Promise<ProjectSpaceFile> {
    projectContentId(id);
    return this.coordinator.view((view) => this.read(view, id));
  }
  async read(view: ProjectContentView, id: string): Promise<ProjectSpaceFile> {
    projectContentId(id);
    const manifest = await readProjectManifest(view, this.owned.projectId);
    if (!manifest.spaceIds.includes(id)) throw new ProjectContentError("notFound");
    const bytes = await view.read(projectSpaceFile(id));
    if (bytes === null) throw new ProjectContentError("conflict");
    const value = decodeProjectSpace(bytes);
    assertSpaceMembership(value.space, manifest, id);
    return value;
  }

  async put(
    input: ProjectSpaceFile,
    expectedVersion: number | null,
    role: "library" | "publication",
    operationId: string,
    author: ContentAuthor,
  ): Promise<ProjectSpaceFile> {
    const encoded = encodeProjectSpace(input),
      value = decodeProjectSpace(encoded);
    const result = await this.coordinator.transact(
      {
        operationId,
        author,
        message: "Save project space metadata",
        intent: stableJson({
          schema: 1,
          kind: "space-put",
          valueHash: contentRequestHash(value),
          expectedVersion,
          role,
        }),
      },
      async (view) => {
        return this.prepare(view, value, expectedVersion, role);
      },
    );
    const bytes = await this.snapshots.fileAt(result.commit, projectSpaceFile(value.space.id));
    if (bytes === null) throw new ProjectContentError("invalidFile");
    return decodeProjectSpace(bytes);
  }
  async prepare(
    view: ProjectContentView,
    input: ProjectSpaceFile,
    expectedVersion: number | null,
    role: "library" | "publication",
  ) {
    const encoded = encodeProjectSpace(input),
      value = decodeProjectSpace(encoded),
      space = value.space;
    if (
      space.projectId !== this.owned.projectId ||
      !["library", "publication"].includes(role) ||
      (expectedVersion !== null &&
        (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || space.version !== expectedVersion + 1))
    )
      throw new ProjectContentError("invalidFile");
    const { manifest, records } = await this.records(view),
      previous = records.find((row) => row.id === space.id);
    if (expectedVersion === null ? !!previous : !previous || previous.version !== expectedVersion)
      throw new ProjectContentError("conflict");
    if (records.some((row) => row.id !== space.id && row.code.toLowerCase() === space.code.toLowerCase()))
      throw new ProjectContentError("conflict");
    if (
      (role === "library") !== (space.code === "__documents__") ||
      (role === "library" &&
        (space.engine !== "markdown" ||
          space.sourceMode !== "managed" ||
          (manifest.librarySpaceId !== null && manifest.librarySpaceId !== space.id)))
    )
      throw new ProjectContentError("conflict");
    if (previous) {
      const old = previous;
      if (
        (manifest.librarySpaceId === space.id) !== (role === "library") ||
        ["code", "engine", "sourceMode", "sourceRoot", "locale", "createdAt"].some(
          (key) => Reflect.get(old, key) !== Reflect.get(space, key),
        )
      )
        throw new ProjectContentError("conflict");
    }
    const changes = [{ path: projectSpaceFile(space.id), content: encoded }];
    if (!previous)
      changes.push({
        path: "project.json",
        content: encodeProjectManifest({
          ...manifest,
          version: manifest.version + 1,
          librarySpaceId: role === "library" ? space.id : manifest.librarySpaceId,
          spaceIds: [...manifest.spaceIds, space.id].sort(),
        }),
      });
    return changes;
  }
}
