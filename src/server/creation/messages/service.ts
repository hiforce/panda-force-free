import { creationUpdateGeneration } from "../../../shared/creation/contracts.js";
import type { SkillCapture } from "../../../shared/skills/registry.js";
import type { CreationTask, CreationLease } from "../contracts.js";
import type { CreationInputs } from "../input.js";
import type {
  CreationMessageStore,
  CreationMessageRecord,
  CreationMessageFiles,
  CreationMessagePayload,
} from "./contracts.js";
import type { CreationMaterialPort } from "../materials.js";
import { CreationError } from "../contracts.js";
import { creationRequest, creationRequestDigest } from "../requests.js";
import { creationId, creationInteger, creationRecord, creationUuid } from "../validation.js";

/** Accepted commands are durable before dispatch; uncertain native acknowledgements are never replayed automatically. */
export class CreationMessages {
  constructor(
    private readonly files: CreationMessageFiles,
    private readonly store: CreationMessageStore,
    private readonly tasks: { get(owner: string, id: string): CreationTask | Promise<CreationTask> },
    private readonly inputs: CreationInputs,
    private readonly capture: (
      owner: string,
      request: import("../../../shared/creation/contracts.js").CreationRequest,
      digest: string,
    ) => Promise<SkillCapture | null>,
    private readonly authorize: (owner: string, project: string) => Promise<void>,
    private readonly materials?: CreationMaterialPort,
  ) {}
  async submit(owner: string, taskId: string, value: unknown, replayOnly = false) {
    const task = await this.tasks.get(owner, creationUuid(taskId));
    await this.authorize(owner, task.spec.projectId);
    const source = await this.inputs.read(task.spec),
      row = creationRecord(value, [
        "id",
        "prompt",
        "selections",
        "attachments",
        "runtimeId",
        "model",
        "effort",
        "outputType",
        "dialogue",
        "updateGeneration",
      ]);
    const request = creationRequest({
      id: row.id,
      projectId: task.spec.projectId,
      treeVersion: task.spec.target.treeVersion,
      parentId: task.spec.target.parentId,
      locale: task.spec.target.locale,
      prompt: row.prompt,
      profileId: source.profile.id,
      ...((row.outputType ?? source.outputType) === undefined
        ? {}
        : { outputType: row.outputType ?? source.outputType }),
      selections: row.selections ?? [],
      attachments: row.attachments ?? [],
      ...(row.runtimeId === undefined ? {} : { runtimeId: creationId(row.runtimeId) }),
      ...(row.model === undefined ? {} : { model: row.model }),
      ...(row.effort === undefined ? {} : { effort: row.effort }),
    });
    const updateGeneration = row.updateGeneration === undefined ? undefined : creationInteger(row.updateGeneration),
      inheritSkills = updateGeneration !== undefined && row.selections === undefined;
    const requestDigest = creationRequestDigest({
        taskId,
        request,
        ...(updateGeneration === undefined ? {} : { updateGeneration, inheritSkills }),
      }),
      prior = await this.store.find(owner, request.id);
    if (prior) {
      if (prior.requestDigest !== requestDigest || prior.taskId !== taskId) throw new CreationError("conflict");
      return prior;
    }
    if (replayOnly) return null;
    if (request.runtimeId && request.runtimeId !== (source.profile.runtimeId ?? "codex"))
      throw new CreationError("conflict");
    if (request.outputType !== source.outputType) throw new CreationError("conflict");
    const canUpdate = (current: CreationTask) =>
      ["queued", "running"].includes(current.state) &&
      !current.outputDigest &&
      !current.cancelRequested &&
      (updateGeneration === undefined || updateGeneration === creationUpdateGeneration(current));
    if (!canUpdate(task)) throw new CreationError(updateGeneration === undefined ? "conflict" : "updateClosed");
    const capture = inheritSkills ? null : await this.capture(owner, request, requestDigest);
    if (request.attachments?.length && !this.materials) throw new CreationError("unavailable");
    const materials = request.attachments?.length ? await this.materials!.prepare(owner, request.attachments) : [];
    const frozen: CreationMessagePayload = {
      schema: 1,
      id: request.id,
      owner,
      taskId,
      requestDigest,
      prompt: request.prompt,
      profile: source.profile,
      skills: capture,
      ...(inheritSkills ? { inheritSkills } : {}),
      materials,
    };
    const payloadDigest = await this.files.put(frozen);
    await this.authorize(owner, task.spec.projectId);
    const now = Date.now();
    try {
      return await this.store.accept({
        id: request.id,
        owner,
        taskId,
        generation: updateGeneration ?? task.generation,
        requestDigest,
        payloadDigest,
        state: "received",
        dispatchGeneration: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (
        updateGeneration !== undefined &&
        error instanceof CreationError &&
        error.code === "conflict" &&
        !canUpdate(await this.tasks.get(owner, taskId))
      )
        throw new CreationError("updateClosed");
      throw error;
    }
  }
  async list(owner: string, taskId: string) {
    const task = await this.tasks.get(owner, taskId);
    await this.authorize(owner, task.spec.projectId);
    const records = await this.store.list(owner, taskId),
      result: Array<{ record: CreationMessageRecord; payload: CreationMessagePayload }> = [];
    for (const record of records) {
      const value = await this.files.read(record.payloadDigest);
      if (
        value.id !== record.id ||
        value.owner !== owner ||
        value.taskId !== taskId ||
        value.requestDigest !== record.requestDigest
      )
        throw new CreationError("unavailable");
      result.push({ record, payload: value });
    }
    await this.authorize(owner, task.spec.projectId);
    return result;
  }
  async context(
    owner: string,
    taskId: string,
    ancestors = new Set<string>(),
  ): Promise<Awaited<ReturnType<CreationMessages["list"]>>> {
    if (ancestors.has(taskId) || ancestors.size >= 32) throw new CreationError("unavailable");
    ancestors.add(taskId);
    const task = await this.tasks.get(owner, taskId);
    await this.authorize(owner, task.spec.projectId);
    const input = await this.inputs.read(task.spec);
    if (!input.recoveryFrom) return this.list(owner, taskId);
    const previous = await this.tasks.get(owner, input.recoveryFrom.taskId);
    if (
      previous.spec.inputDigest !== input.recoveryFrom.inputDigest ||
      previous.spec.projectId !== task.spec.projectId ||
      (previous.state !== "failed" && previous.state !== "committing") ||
      previous.artifact
    )
      throw new CreationError("conflict");
    const inherited = await this.context(owner, previous.spec.id, ancestors);
    const own = await this.list(owner, taskId);
    await this.authorize(owner, task.spec.projectId);
    if (inherited.length + own.length > 1024) throw new CreationError("unavailable");
    const all = [...inherited, ...own];
    const selected = all.findLastIndex(({ payload }) => !payload.inheritSkills);
    return all.map((entry, index) =>
      index === selected ? entry : { ...entry, payload: { ...entry.payload, skills: null } },
    );
  }
  claim(lease: CreationLease) {
    return this.store.claim(lease, Date.now());
  }
  settle(lease: CreationLease, id: string, state: "delivered" | "uncertain") {
    return this.store.settle(lease, id, state, Date.now());
  }
  seen(lease: CreationLease, ids: readonly string[]) {
    return this.store.seen(lease, ids, Date.now());
  }
  async read(record: CreationMessageRecord) {
    const value = await this.files.read(record.payloadDigest);
    if (
      value.id !== record.id ||
      value.owner !== record.owner ||
      value.taskId !== record.taskId ||
      value.requestDigest !== record.requestDigest
    )
      throw new CreationError("unavailable");
    return value;
  }
  async public(owner: string, taskId: string) {
    return (await this.list(owner, taskId)).map(({ record, payload }) => ({
      id: record.id,
      text: payload.prompt,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      selections:
        payload.skills?.composition.skills.map(({ packageId, version, digest, id, parameters }) => ({
          packageId,
          version,
          digest,
          id,
          parameters,
        })) || [],
      attachments: payload.materials.map((material) => ({
        id: material.id,
        materialId: material.id,
        name: material.name,
        kind: material.kind,
        status: "ready",
        url: "/api/creation-materials/original?id=" + material.id,
      })),
    }));
  }
}
