import type { CreativeAssetPurges } from "./purge.js";
import type { OriginalObjectStorage, OriginalUploadPlan } from "../../object-storage/originals.js";
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
import { creativeMetadata, creativeOriginalScope } from "./files.js";
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
    private readonly objects?: OriginalObjectStorage,
    private readonly purges?: CreativeAssetPurges,
  ) {
    super(projects, assetRoot, undefined, objects);
  }
  save(actor: string, project: string, value: CreativeSaveInput, signal?: AbortSignal, verify?: () => Promise<void>) {
    const input = creativeSaveInput(value);
    return documentFileOperation(async () => {
      await this.projects.authorize(project);
      await validateCreativeOriginal(input, signal);
      if (signal?.aborted) throw new DocumentError("unavailable", 503);
      return this.commit(
        actor,
        project,
        input,
        undefined,
        async () => {
          if (signal?.aborted) throw new DocumentError("unavailable", 503);
          await verify?.();
        },
        signal,
      );
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
        await this.assertNotPurged(owner, target.project, target.id);
        const previous = await owner.coordinator.plannedReceipt(command);
        if (previous) {
          await guard();
          return this.receipt(owner.owned, previous.commit, target.id);
        }
        const original = await source.original(captured.project, captured.id, signal);
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
        return this.write(
          owner,
          target.project,
          input,
          { ...captured, commit: original.commit },
          guard,
          command,
          signal,
        );
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
        await owner.coordinator.view(async () => {
          await this.purges?.assertNotRequested(owner.owned, id);
        });
        const receipt = await owner.coordinator.plan(
          {
            operationId,
            author: documentAuthor(actor),
            message: "Change authored asset availability",
            intent: stableJson({ id, version, state }),
          },
          async (view) => {
            const previous = await creativeMetadata(view, project, id, true);
            if (previous.version !== version || !["saved", "trashed"].includes(previous.state))
              throw new ProjectContentError("conflict");
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
  permanentDelete(actor: string, project: string, id: string, version: string, operationId: string) {
    creativeAssetId(id);
    fileDigest(version);
    if (!this.purges) throw new DocumentError("unavailable", 503);
    return documentFileOperation(() =>
      this.projects.write(project, async (owner) => {
        const existing = await owner.coordinator.view(async (view) => ({
          asset: await creativeMetadata(view, project, id, true),
          commit: view.commit,
        }));
        if (
          ["purging", "purged"].includes(existing.asset.state) &&
          existing.asset.purge?.requestedVersion === version
        ) {
          if (existing.asset.state === "purging") void this.purges!.retry(owner.owned, existing.asset).catch(() => {});
          return { ...existing, status: await this.purges!.status(owner.owned, existing.asset) };
        }
        let job: { id: string; operationId: string } | undefined;
        await owner.coordinator.plan(
          {
            operationId,
            author: documentAuthor(actor),
            message: "Request permanent authored asset deletion",
            intent: stableJson({ id, version, state: "purging" }),
          },
          async (view) => {
            const previous = await creativeMetadata(view, project, id, true);
            if (previous.state !== "trashed" || previous.version !== version) throw new ProjectContentError("conflict");
            job = await this.purges!.reserve(owner.owned, previous, operationId);
            const { version: _version, ...old } = previous,
              content = {
                ...old,
                state: "purging" as const,
                previousVersion: previous.version,
                purge: { operationId: job.operationId, requestedVersion: version },
                updatedAt: Date.now(),
              };
            return {
              changes: [
                {
                  path: projectCreationFile(id),
                  content: encodeCreativeAsset({ ...content, version: creativeVersion(content) }),
                },
              ],
            };
          },
        );
        if (job) void this.purges!.run(job.id).catch(() => {});
        const current = await owner.coordinator.view(async (view) => ({
          asset: await creativeMetadata(view, project, id, true),
          commit: view.commit,
        }));
        if (current.asset.purge?.requestedVersion !== version || !["purging", "purged"].includes(current.asset.state))
          throw new ProjectContentError("conflict");
        if (!job && current.asset.state === "purging")
          void this.purges!.retry(owner.owned, current.asset).catch(() => {});
        return { ...current, status: await this.purges!.status(owner.owned, current.asset) };
      }),
    );
  }
  purgeStatus(project: string, id: string, retry = false) {
    if (!this.purges) throw new DocumentError("unavailable", 503);
    return documentFileOperation(() =>
      this.projects.write(project, async (owner) => {
        const asset = await owner.coordinator.view((view) => creativeMetadata(view, project, id, true));
        if (!["purging", "purged"].includes(asset.state)) throw new ProjectContentError("conflict");
        if (retry && asset.state === "purging") void this.purges!.retry(owner.owned, asset).catch(() => {});
        return { asset, status: await this.purges!.status(owner.owned, asset) };
      }),
    );
  }
  private commit(
    actor: string,
    project: string,
    input: CreativePrepared,
    copiedFrom?: CreativeAsset["copiedFrom"],
    guard = async () => {},
    signal?: AbortSignal,
  ) {
    const descriptors = creativeDescriptors(input);
    return this.projects.initialize(project, (owner) =>
      this.write(
        owner,
        project,
        input,
        copiedFrom,
        guard,
        {
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
        },
        signal,
      ),
    );
  }
  private async assertNotPurged(owner: ProjectContentProject, project: string, id: string) {
    await owner.coordinator.view(async (view) => {
      await this.purges?.assertNotRequested(owner.owned, id);
      const bytes = await view.read(projectCreationFile(id));
      if (bytes) {
        const asset = decodeCreativeAsset(bytes);
        if (asset.project !== project || asset.id !== id || ["purging", "purged"].includes(asset.state))
          throw new ProjectContentError("conflict");
      }
    });
  }
  private previous(input: CreativePrepared, project: string, bytes: Buffer | null) {
    const previous = bytes ? decodeCreativeAsset(bytes) : null;
    if (
      (previous?.version ?? null) !== input.expectedVersion ||
      (previous &&
        (previous.project !== project ||
          previous.id !== input.id ||
          previous.state !== "saved" ||
          previous.kind !== input.kind))
    )
      throw new ProjectContentError("conflict");
    return previous;
  }
  private async write(
    owner: ProjectContentProject,
    project: string,
    input: CreativePrepared,
    copiedFrom: CreativeAsset["copiedFrom"],
    guard: () => Promise<void>,
    command: ProjectContentCommand & { intent: string },
    signal?: AbortSignal,
  ) {
    const descriptors = creativeDescriptors(input);
    await this.assertNotPurged(owner, project, input.id);
    const replay = await owner.coordinator.plannedReceipt(command);
    if (replay) {
      await guard();
      return this.receipt(owner.owned, replay.commit, input.id);
    }
    let storage: OriginalUploadPlan | undefined;
    let local: Awaited<ReturnType<typeof this.files.blobs>> | undefined;
    await owner.coordinator.view(async (view) => {
      await guard();
      const previous = this.previous(input, project, await view.read(projectCreationFile(input.id)));
      storage = await this.objects?.reserve(creativeOriginalScope(owner.owned, input.id), input.kind, [
        descriptors.source,
        ...descriptors.resources,
      ]);
      if (previous?.hasObjectHistory && !storage?.history) throw new ProjectContentError("unavailable");
      // Initialize binary ownership under the project lease; put the large blobs after releasing it.
      if (!storage?.remote && (input.kind !== "web" || input.resources.length))
        local = await this.files.blobs(owner.owned, true);
    });
    if (storage?.remote) {
      await this.objects!.upload(
        storage,
        [
          { digest: descriptors.source.digest, bytes: input.bytes },
          ...input.resources.map((resource, i) => ({
            digest: descriptors.resources[i]!.digest,
            bytes: resource.bytes,
          })),
        ],
        signal,
      );
    } else if (local) {
      if (input.kind !== "web") await local.put(descriptors.source.digest, input.bytes);
      for (const [i, resource] of input.resources.entries())
        if (resource.bytes.length) await local.put(descriptors.resources[i]!.digest, resource.bytes);
    }
    const receipt = await owner.coordinator.plan(command, async (view) => {
      await guard();
      const path = projectCreationFile(input.id),
        previous = this.previous(input, project, await view.read(path));
      const now = Date.now(),
        content: Omit<CreativeAsset, "version"> = {
          schema: 1,
          id: input.id,
          project,
          kind: input.kind,
          title: input.title,
          locale: input.locale,
          state: "saved",
          ...(storage?.remote ? { originalStore: "object" as const } : {}),
          ...(storage?.history || previous?.hasObjectHistory ? { hasObjectHistory: true as const } : {}),
          previousVersion: input.expectedVersion,
          ...descriptors,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          ...((copiedFrom ?? previous?.copiedFrom) ? { copiedFrom: copiedFrom ?? previous!.copiedFrom! } : {}),
        };
      return {
        changes: [
          { path, content: encodeCreativeAsset({ ...content, version: creativeVersion(content) }) },
          ...(input.kind === "web"
            ? [{ path: projectCreationHtml(input.id), content: storage?.remote ? null : input.bytes }]
            : []),
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
