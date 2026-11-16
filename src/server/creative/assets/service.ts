import { documentAuthor } from "../../documents/files/commands.js";
import type { DocumentFileProjects } from "../../documents/files/projects.js";
import { documentFileOperation } from "../../documents/files/errors.js";
import { DocumentError } from "../../documents/errors.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { ProjectGitSnapshots } from "../../project-content/git/snapshot.js";
import type { ProjectContentProject } from "../../project-content/project.js";
import type { ProjectContentCommand } from "../../project-content/mutation.js";
import { fileDigest } from "../../project-content/codec-values.js";
import { projectContentId, projectCreationFile, projectCreationHtml } from "../../project-content/paths.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { CreativeAsset } from "../../../shared/creative/assets.js";
import { creativeAssetId, creativeVersion, decodeCreativeAsset, encodeCreativeAsset } from "./codec.js";
import { creativeMetadata } from "./files.js";
import { FileCreativeAssetReader } from "./reader.js";
import {
  creativeDescriptors,
  creativeSaveInput,
  validateCreativeOriginal,
  type CreativePrepared,
  type CreativeSaveInput,
} from "./prepare.js";

/** Only an authorized content authority can create originals; metadata is never a separate approval or search database. */
export class FileCreativeAssets extends FileCreativeAssetReader {
  constructor(
    private readonly projects: DocumentFileProjects,
    assetRoot: string,
  ) {
    super(projects, assetRoot);
  }
  save(actor: string, project: string, value: CreativeSaveInput, signal?: AbortSignal) {
    const input = creativeSaveInput(value);
    return documentFileOperation(async () => {
      await this.projects.authorize(project);
      await validateCreativeOriginal(input, signal);
      if (signal?.aborted) throw new DocumentError("unavailable", 503);
      return this.commit(actor, project, input, undefined, async () => {
        if (signal?.aborted) throw new DocumentError("unavailable", 503);
      });
    });
  }
  async copyFrom(
    source: FileCreativeAssetReader,
    actor: string,
    from: { project: string; id: string; version: string },
    project: string,
    id: string,
    operationId: string,
    signal?: AbortSignal,
  ) {
    const captured = {
        project: projectContentId(from.project),
        id: creativeAssetId(from.id),
        version: fileDigest(from.version),
      },
      target = { project: projectContentId(project), id: creativeAssetId(id) },
      command = {
        operationId: projectContentId(operationId),
        author: documentAuthor(actor),
        message: "Copy authored creative asset",
        intent: stableJson({ schema: 1, kind: "creative-copy", source: captured, target }),
      },
      guard = async () => {
        if (signal?.aborted) throw new DocumentError("unavailable", 503);
        await source.authorize(captured.project);
      };
    await guard();
    return documentFileOperation(() =>
      this.projects.initialize(target.project, async (owner) => {
        // Replay uses stable request identity before consulting a source that may since have changed or been trashed.
        const previous = await owner.coordinator.plannedReceipt(command);
        if (previous) {
          await guard();
          return this.receipt(owner.owned, previous.commit, target.id);
        }
        const original = await source.original(captured.project, captured.id);
        if (original.asset.version !== captured.version) throw new DocumentError("conflict", 409);
        const input = creativeSaveInput({
          id: target.id,
          operationId,
          expectedVersion: null,
          kind: original.asset.kind,
          title: original.asset.title,
          locale: original.asset.locale,
          name: original.asset.source.name,
          bytes: original.bytes,
          resources: original.resources,
        });
        return this.write(owner, target.project, input, { ...captured, commit: original.commit }, guard, command);
      }),
    );
  }
  setState(
    actor: string,
    project: string,
    id: string,
    version: string,
    state: CreativeAsset["state"],
    operationId: string,
  ) {
    creativeAssetId(id);
    projectContentId(operationId);
    if (!["saved", "trashed"].includes(state)) throw new DocumentError("invalidInput");
    return documentFileOperation(() =>
      this.projects.write(project, async (owner) => {
        const receipt = await owner.coordinator.plan(
          {
            operationId,
            author: documentAuthor(actor),
            message: "Change authored asset availability",
            intent: stableJson({ id, version, state }),
          },
          async (view) => {
            const previous = await creativeMetadata(view, project, id, true);
            if (previous.version !== version) throw new ProjectContentError("conflict");
            const { version: _version, ...content } = previous,
              updated = { ...content, state, previousVersion: previous.version, updatedAt: Date.now() };
            return {
              changes: [
                {
                  path: projectCreationFile(id),
                  content: encodeCreativeAsset({ ...updated, version: creativeVersion(updated) }),
                },
              ],
            };
          },
        );
        return this.receipt(owner.owned, receipt.commit, id);
      }),
    );
  }
  private commit(
    actor: string,
    project: string,
    input: CreativePrepared,
    copiedFrom?: CreativeAsset["copiedFrom"],
    guard = async () => {},
  ) {
    const descriptors = creativeDescriptors(input);
    return this.projects.initialize(project, (owner) =>
      this.write(owner, project, input, copiedFrom, guard, {
        operationId: input.operationId,
        author: documentAuthor(actor),
        message: "Save authored creative asset",
        intent: stableJson({
          id: input.id,
          project,
          expectedVersion: input.expectedVersion,
          kind: input.kind,
          title: input.title,
          locale: input.locale,
          ...descriptors,
          ...(copiedFrom ? { copiedFrom } : {}),
        }),
      }),
    );
  }
  private async write(
    owner: ProjectContentProject,
    project: string,
    input: CreativePrepared,
    copiedFrom: CreativeAsset["copiedFrom"],
    guard: () => Promise<void>,
    command: ProjectContentCommand & { intent: string },
  ) {
    const descriptors = creativeDescriptors(input);
    if (input.kind === "slides" || input.resources.length) {
      const blobs = await this.files.blobs(owner.owned, true);
      if (input.kind === "slides") await blobs.put(descriptors.source.digest, input.bytes);
      for (const [i, resource] of input.resources.entries())
        if (resource.bytes.length) await blobs.put(descriptors.resources[i]!.digest, resource.bytes);
    }
    const receipt = await owner.coordinator.plan(command, async (view) => {
      await guard();
      const path = projectCreationFile(input.id),
        bytes = await view.read(path),
        previous = bytes ? decodeCreativeAsset(bytes) : null;
      if (
        (previous?.version ?? null) !== input.expectedVersion ||
        (previous &&
          (previous.project !== project ||
            previous.id !== input.id ||
            previous.state !== "saved" ||
            previous.kind !== input.kind))
      )
        throw new ProjectContentError("conflict");
      const now = Date.now(),
        content: Omit<CreativeAsset, "version"> = {
          schema: 1,
          id: input.id,
          project,
          kind: input.kind,
          title: input.title,
          locale: input.locale,
          state: "saved",
          previousVersion: input.expectedVersion,
          ...descriptors,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          ...((copiedFrom ?? previous?.copiedFrom) ? { copiedFrom: copiedFrom ?? previous!.copiedFrom! } : {}),
        };
      return {
        changes: [
          { path, content: encodeCreativeAsset({ ...content, version: creativeVersion(content) }) },
          ...(input.kind === "web" ? [{ path: projectCreationHtml(input.id), content: input.bytes }] : []),
        ],
      };
    });
    await guard();
    return this.receipt(owner.owned, receipt.commit, input.id);
  }
  private async receipt(owned: ConstructorParameters<typeof ProjectGitSnapshots>[0], commit: string, id: string) {
    const bytes = await new ProjectGitSnapshots(owned).fileAt(commit, projectCreationFile(id));
    if (!bytes) throw new ProjectContentError("unavailable");
    return { asset: decodeCreativeAsset(bytes), commit };
  }
}
