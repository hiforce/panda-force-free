import { mapMetadata, type MetadataStore } from "../../../shared/async-value.js";
import type { SourceStageStore } from "../staging/ports.js";
import type { OwnedSourceMetadata } from "./ports.js";
import type { PackageSourceStages } from "../staging/service.js";
import type { PackageSourceIngestion } from "../ingestion/service.js";
import { SourceStageError } from "../../../shared/packages/stages/contracts.js";
import { OwnedSourceError, type OwnedPackageSources } from "../../../shared/packages/ownership.js";

/** Accepted immutable sources reuse the staging owner's quotas, leases, fences and read-drain policy. */
export function ownedStagedSources(stages: PackageSourceStages, ingestion: PackageSourceIngestion): OwnedPackageSources;
export function ownedStagedSources(
  stages: PackageSourceStages<MetadataStore<SourceStageStore>>,
  ingestion: PackageSourceIngestion<MetadataStore<SourceStageStore>>,
): OwnedSourceMetadata;
export function ownedStagedSources(
  stages: PackageSourceStages<MetadataStore<SourceStageStore>>,
  ingestion: PackageSourceIngestion<MetadataStore<SourceStageStore>>,
): OwnedSourceMetadata {
  const view = (actor: string, operationId: string) => stages.operation(actor, operationId);
  return {
    async save(actor, operationId, source) {
      const origin = source.descriptor.origin,
        selected = [...source.tree.files, ...(source.links?.files ?? [])].map((file) => file.path).sort(),
        request = {
          source:
            origin.kind === "zip-upload"
              ? {
                  kind: "zip-upload",
                  name: origin.name,
                  bytes: source.descriptor.archiveBytes,
                  sha256: origin.archiveSha256,
                }
              : {
                  kind: "github",
                  repository: origin.repository,
                  repositoryId: origin.repositoryId,
                  ref: origin.requestedRef,
                  root: origin.root,
                },
          selected,
        };
      try {
        let stage = await stages.submit(actor, operationId, request);
        if (stage.state === "ready") {
          if (stage.digest !== source.digest) throw new OwnedSourceError("conflict");
          return { id: stage.id, digest: stage.digest };
        }
        if (!["reserved", "uploaded"].includes(stage.state))
          throw new OwnedSourceError(
            ["acquiring", "writing", "uploading"].includes(stage.state) ? "busy" : "unavailable",
          );
        stage = await stages.execute(actor, stage.id, stage.revision, async () => source);
        if (stage.state !== "ready" || stage.digest !== source.digest) throw new OwnedSourceError("unavailable");
        return { id: stage.id, digest: stage.digest };
      } catch (error) {
        if (error instanceof SourceStageError) {
          if (["stageBusy", "stageConflict"].includes(error.code)) throw new OwnedSourceError("busy");
          if (error.code === "stageCapacity") throw new OwnedSourceError("capacity");
        }
        throw error;
      }
    },
    find(actor, operationId) {
      return mapMetadata(view(actor, operationId), (stage) =>
        stage ? { ref: { id: stage.id, digest: stage.digest ?? "" }, state: stage.state } : null,
      );
    },
    async with(actor, source, run) {
      try {
        return await ingestion.consume(actor, "templates", source.id, source.digest, run);
      } catch (error) {
        if (error instanceof SourceStageError && error.code === "stageBusy") throw new OwnedSourceError("busy");
        throw error;
      }
    },
    async recover(actor, operationId) {
      const current = await view(actor, operationId);
      if (!current) return null;
      if (["writing", "acquiring", "uploading", "failed"].includes(current.state)) {
        try {
          await stages.recover(actor, current.id, current.revision);
        } catch (error) {
          if (error instanceof SourceStageError && ["stageBusy", "stageConflict"].includes(error.code))
            throw new OwnedSourceError("busy");
          throw error;
        }
      }
      const stage = (await view(actor, operationId))!;
      if (stage.state === "ready" && stage.digest) return { id: stage.id, digest: stage.digest };
      if (["acquiring", "writing", "uploading"].includes(stage.state)) throw new OwnedSourceError("busy");
      return null;
    },
    async remove(actor, operationId) {
      const stage = await view(actor, operationId);
      if (stage && stage.state !== "removed") await stages.remove(actor, stage.id, stage.revision);
    },
  };
}
