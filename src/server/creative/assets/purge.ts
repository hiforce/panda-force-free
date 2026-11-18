import { dirname, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type { CreativeAsset } from "../../../shared/creative/assets.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { OriginalObjectStorage } from "../../object-storage/originals.js";
import { ObjectStorageError } from "../../object-storage/contracts.js";
import { originalIntegrity, originalScope, type OriginalScope } from "../../object-storage/original-codec.js";
import { storageDigest, storageOperationId, storageRecord, storageText } from "../../object-storage/config-codec.js";
import { openOwnedProjectDirectory, type OwnedProjectDirectory } from "../../project-content/owned-directory.js";
import { ProjectContentProject } from "../../project-content/project.js";
import { projectCreationFile, projectCreationHtml } from "../../project-content/paths.js";
import { creativeVersion, encodeCreativeAsset } from "./codec.js";
import { creativeMetadata, creativeOriginalScope } from "./files.js";

interface PurgeJob {
  schema: 1;
  id: string;
  scope: OriginalScope;
  directory: string;
  operationId: string;
  signature: string;
}
export interface CreativePurgeStatus {
  state: "pending" | "complete";
  code?: string;
}
const path = (id: string, suffix = ".json") => ["purges", id.slice(0, 2), id + suffix];
/** A sealed job is executable only after its permanent-deletion intent is present in the owning project's committed metadata. */
export class CreativeAssetPurges {
  private readonly running = new Map<string, Promise<CreativePurgeStatus>>();
  private readonly stopping = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cursor = "";
  constructor(
    private readonly objects: OriginalObjectStorage,
    private readonly roots: readonly string[],
  ) {}
  private async signature(value: Omit<PurgeJob, "signature">) {
    return this.objects.files.scope(stableJson(value));
  }
  private async id(scope: OriginalScope, operationId: string) {
    return this.objects.files.scope(stableJson({ scope, operationId }));
  }
  private async requestPath(scope: OriginalScope) {
    const key = await this.objects.files.scope(stableJson(scope));
    return ["permanent-requests", key.slice(0, 2), key + ".json"];
  }
  async assertNotRequested(owned: OwnedProjectDirectory, id: string) {
    if (!(await this.objects.files.present())) return;
    if ((await this.objects.files.read(await this.requestPath(creativeOriginalScope(owned, id)))) !== null)
      throw new ObjectStorageError("storageConflict");
  }
  async reserve(owned: OwnedProjectDirectory, asset: CreativeAsset, operationId: string) {
    await owned.verify();
    storageOperationId(operationId);
    const scope = creativeOriginalScope(owned, asset.id);
    if (asset.hasObjectHistory && !(await this.objects.hasHistory(scope))) originalIntegrity();
    const requestPath = await this.requestPath(scope),
      request = { scope, operationId, requestedVersion: asset.version, directory: owned.directory };
    await this.objects.files.writeOnce(requestPath, {
      ...request,
      signature: await this.objects.files.scope(stableJson(request)),
    });
    const raw = storageRecord(await this.objects.files.read(requestPath), [
        "scope",
        "operationId",
        "requestedVersion",
        "directory",
        "signature",
      ]),
      recorded = {
        scope,
        operationId: storageOperationId(raw.operationId),
        requestedVersion: storageDigest(raw.requestedVersion),
        directory: owned.directory,
      };
    if (
      raw.directory !== owned.directory ||
      stableJson(raw.scope) !== stableJson(scope) ||
      recorded.requestedVersion !== asset.version ||
      raw.signature !== (await this.objects.files.scope(stableJson(recorded)))
    )
      throw new ObjectStorageError("storageConflict");
    operationId = recorded.operationId;
    const id = await this.id(scope, operationId),
      value = { schema: 1 as const, id, scope, directory: owned.directory, operationId },
      job = { ...value, signature: await this.signature(value) };
    if (
      !(await this.objects.files.writeOnce(path(id), job)) &&
      stableJson(await this.objects.files.read(path(id))) !== stableJson(job)
    )
      originalIntegrity();
    await this.objects.files.writeOnce(["purge-pending", id.slice(0, 2), id + ".json"], { id });
    await this.objects.beginPurge(scope, operationId);
    return { id, operationId };
  }
  private async read(id: string) {
    storageDigest(id);
    const raw = storageRecord(await this.objects.files.read(path(id)), [
        "schema",
        "id",
        "scope",
        "directory",
        "operationId",
        "signature",
      ]),
      value = {
        schema: 1 as const,
        id: storageDigest(raw.id),
        scope: originalScope(raw.scope as OriginalScope),
        directory: storageText(raw.directory, 4096),
        operationId: storageOperationId(raw.operationId),
      };
    if (
      raw.schema !== 1 ||
      value.id !== id ||
      (await this.id(value.scope, value.operationId)) !== id ||
      (await this.signature(value)) !== raw.signature
    )
      originalIntegrity();
    return { ...value, signature: raw.signature as string };
  }
  private async marker(job: PurgeJob, suffix: string, create = false) {
    const value = { id: job.id, signature: await this.objects.files.scope(stableJson({ job, marker: suffix })) };
    if (create) await this.objects.files.writeOnce(path(job.id, suffix), value);
    const actual = await this.objects.files.read(path(job.id, suffix));
    if (actual !== null && stableJson(actual) !== stableJson(value)) originalIntegrity();
    return actual !== null;
  }
  private async owner(job: PurgeJob) {
    let allowed = false;
    for (const root of this.roots) {
      const base = await realpath(root),
        parts = relative(base, job.directory).split(sep);
      if (
        (parts.length === 2 && parts[0] === "projects" && parts[1] === job.scope.projectId) ||
        (parts.length === 4 &&
          parts[0] === "personal" &&
          /^[a-f0-9]{64}$/.test(parts[1]!) &&
          parts[2] === "projects" &&
          parts[3] === job.scope.projectId)
      )
        allowed = true;
    }
    if (!allowed) originalIntegrity();
    const owned = await openOwnedProjectDirectory(dirname(dirname(job.directory)), job.scope.projectId);
    if (owned.directory !== job.directory || owned.ownerId !== job.scope.ownerId) originalIntegrity();
    return new ProjectContentProject(owned);
  }
  private async state(owner: ProjectContentProject, job: PurgeJob) {
    return owner.coordinator.view(async (view) => {
      const asset = await creativeMetadata(view, job.scope.projectId, job.scope.assetId, true);
      if (!["purging", "purged"].includes(asset.state) || asset.purge?.operationId !== job.operationId) return null;
      return asset;
    });
  }
  async status(owned: OwnedProjectDirectory, asset: CreativeAsset): Promise<CreativePurgeStatus> {
    if (asset.state === "purged") return { state: "complete" };
    if (asset.state !== "purging" || !asset.purge) throw new ObjectStorageError("storageConflict");
    const job = await this.read(await this.id(creativeOriginalScope(owned, asset.id), asset.purge.operationId));
    if (await this.marker(job, ".done.json")) return { state: "complete" };
    for (const code of ["storageDenied", "storageIntegrity", "storageUnavailable", "storageConflict"])
      if (await this.marker(job, "." + code.toLowerCase() + ".json")) return { state: "pending", code };
    return { state: "pending" };
  }
  run(id: string): Promise<CreativePurgeStatus> {
    let work = this.running.get(id);
    if (!work) {
      work = this.perform(id).finally(() => {
        this.running.delete(id);
      });
      this.running.set(id, work);
    }
    return work;
  }
  private async perform(id: string): Promise<CreativePurgeStatus> {
    const job = await this.read(id);
    if (await this.marker(job, ".done.json")) {
      await this.objects.files.remove(["purge-pending", id.slice(0, 2), id + ".json"]);
      return { state: "complete" };
    }
    try {
      const owner = await this.owner(job),
        initial = await this.state(owner, job);
      if (!initial) return { state: "pending" };
      if (initial.state !== "purged") {
        if (initial.hasObjectHistory && !(await this.objects.hasHistory(job.scope))) originalIntegrity();
        const committed = async () => {
          if (this.stopping.signal.aborted || !(await this.state(owner, job)))
            throw new ObjectStorageError("storageUnavailable", true);
        };
        const cleaned = await this.objects.purge(
          job.scope,
          job.operationId,
          committed,
          AbortSignal.any([this.stopping.signal, AbortSignal.timeout(120000)]),
        );
        if (!cleaned.complete) return { state: "pending" };
        await owner.coordinator.plan(
          {
            operationId: "purged-" + job.id,
            author: { name: "PandaForce", email: "content@pandaforce.local" },
            message: "Complete permanent authored asset deletion",
            intent: stableJson({ job: job.id, operationId: job.operationId }),
          },
          async (view) => {
            const asset = await creativeMetadata(view, job.scope.projectId, job.scope.assetId, true);
            if (asset.state !== "purging" || asset.purge?.operationId !== job.operationId)
              throw new ObjectStorageError("storageConflict");
            const { version: _version, ...previous } = asset,
              content = {
                ...previous,
                state: "purged" as const,
                previousVersion: asset.version,
                updatedAt: Date.now(),
              };
            return {
              changes: [
                {
                  path: projectCreationFile(asset.id),
                  content: encodeCreativeAsset({ ...content, version: creativeVersion(content) }),
                },
                ...(asset.kind === "web" ? [{ path: projectCreationHtml(asset.id), content: null }] : []),
              ],
            };
          },
        );
      }
      await this.marker(job, ".done.json", true);
      await this.objects.files.remove(["purge-pending", id.slice(0, 2), id + ".json"]);
      return { state: "complete" };
    } catch (error) {
      const code =
        error instanceof ObjectStorageError &&
        ["storageDenied", "storageIntegrity", "storageConflict"].includes(error.code)
          ? error.code
          : "storageUnavailable";
      await this.marker(job, "." + code.toLowerCase() + ".json", true);
      return { state: "pending", code };
    }
  }
  async retry(owned: OwnedProjectDirectory, asset: CreativeAsset) {
    if (!asset.purge) throw new ObjectStorageError("storageConflict");
    return this.run(await this.id(creativeOriginalScope(owned, asset.id), asset.purge.operationId));
  }
  start() {
    if (this.timer || this.stopping.signal.aborted) return;
    const tick = async () => {
      try {
        const jobs: string[] = [];
        for (const shard of await this.objects.files.directories(["purge-pending"])) {
          for (const name of await this.objects.files.list(["purge-pending", shard]))
            if (/^[a-f0-9]{64}\.json$/.test(name)) jobs.push(name.slice(0, -5));
        }
        jobs.sort();
        const after = jobs.filter((id) => id > this.cursor),
          batch = (after.length ? after : jobs).slice(0, 4);
        for (const id of batch) {
          if (this.stopping.signal.aborted) break;
          this.cursor = id;
          await this.run(id);
        }
      } catch {
        /* Failed ownership or storage reads remain pending; page loads never await this worker. */
      }
      if (!this.stopping.signal.aborted) {
        this.timer = setTimeout(() => {
          void tick();
        }, 15000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => {
      void tick();
    }, 1000);
    this.timer.unref();
  }
  async close() {
    clearTimeout(this.timer);
    this.stopping.abort();
    await Promise.allSettled(this.running.values());
  }
}
