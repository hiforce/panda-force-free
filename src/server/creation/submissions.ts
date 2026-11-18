import type { CreationResult } from "./ports.js";
import type { CreationInputs, CreationEngineProfile, CreationRequest } from "./input.js";
import type { SkillCapture } from "../../shared/skills/registry.js";
import type { CreationTask } from "./contracts.js";
import { CreationError } from "./contracts.js";
import { creationText, creationRecord, creationUuid } from "./validation.js";
import { creationOperation, creationRequest, creationRequestDigest } from "./requests.js";

export interface CreationSubmissionTasks {
  find(owner: string, id: string): CreationResult<CreationTask | null>;
  create(value: unknown, now: number): CreationResult<CreationTask>;
}
export interface CreationSubmissionAuthority {
  /** Called again after asynchronous capture and staging; project existence is not a durable permission grant. */
  authorize(owner: string, projectId: string): Promise<void>;
  target(owner: string, request: CreationRequest): Promise<void>;
  revision?: import("./ports.js").CreationDocumentRevisions["read"];
  original?(
    owner: string,
    artifact: import("../../shared/creation/contracts.js").CreationAssetArtifact,
  ): Promise<import("../../shared/creation/contracts.js").CreationAssetArtifact>;
  profile(id: string, selection?: { model?: string; effort?: string }): Promise<CreationEngineProfile>;
  capture(owner: string, request: CreationRequest, requestDigest: string): Promise<SkillCapture>;
}
/** Submission is idempotent before mutable catalogs are consulted. Only the first accepted input snapshot enters the queue. */
export class CreationSubmissions {
  constructor(
    private readonly tasks: CreationSubmissionTasks,
    private readonly inputs: CreationInputs,
    private readonly authority: CreationSubmissionAuthority,
    private readonly now: () => number = Date.now,
    private readonly materials?: import("./materials.js").CreationMaterialPort,
    private readonly messages?: Pick<import("./messages/service.js").CreationMessages, "context">,
    private readonly savedArtifact?: (
      owner: string,
      id: string,
    ) => Promise<import("./contracts.js").CreationArtifact | null>,
  ) {}
  async recover(owner: string, id: string, operationId: string) {
    const task = await this.tasks.find(owner, creationUuid(id));
    if (!task) throw new CreationError("notFound");
    await this.authority.authorize(owner, task.spec.projectId);
    if (task.artifact || task.failure !== "targetChanged" || !["failed", "committing"].includes(task.state))
      throw new CreationError("conflict");
    const input = await this.inputs.read(task.spec);
    const updates = (await this.messages?.context(owner, id)) || [];
    const skills = updates.length
      ? updates.at(-1)!.payload.skills?.composition.skills || []
      : input.skills.composition.skills;
    return this.write(
      owner,
      {
        id: creationUuid(operationId),
        previousTaskId: task.spec.id,
        projectId: task.spec.projectId,
        treeVersion: task.spec.target.treeVersion,
        parentId: task.spec.target.parentId,
        locale: task.spec.target.locale,
        prompt: input.prompt,
        ...(input.outputType === undefined ? {} : { outputType: input.outputType }),
        profileId: input.profile.id,
        ...(input.profile.model ? { model: input.profile.model } : {}),
        ...(input.profile.effort ? { effort: input.profile.effort } : {}),
        attachments: (input.materials || []).map(({ id }) => ({ materialId: id })),
        selections: skills.map(({ packageId, version, digest, id, parameters }) => ({
          packageId,
          version,
          digest,
          id,
          parameters,
        })),
      },
      { taskId: task.spec.id, inputDigest: task.spec.inputDigest },
    );
  }
  async followUp(owner: string, id: string, value: unknown) {
    const request = creationRecord(value, [
        "id",
        "prompt",
        "selections",
        "model",
        "effort",
        "attachments",
        "outputType",
      ]),
      task = await this.tasks.find(owner, creationUuid(id));
    if (!task) throw new CreationError("notFound");
    await this.authority.authorize(owner, task.spec.projectId);
    const input = await this.inputs.read(task.spec);
    return this.submit(owner, {
      id: request.id,
      prompt: request.prompt,
      previousTaskId: task.spec.id,
      projectId: task.spec.projectId,
      treeVersion: task.spec.target.treeVersion,
      parentId: task.spec.target.parentId,
      locale: task.spec.target.locale,
      profileId: input.profile.id,
      ...((request.outputType ?? input.outputType) === undefined
        ? {}
        : { outputType: request.outputType ?? input.outputType }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      selections:
        request.selections ??
        input.skills.composition.skills.map(({ packageId, version, digest, id, parameters }) => ({
          packageId,
          version,
          digest,
          id,
          parameters,
        })),
    });
  }
  async submit(actor: string, value: unknown) {
    return this.write(actor, value);
  }
  private async write(
    actor: string,
    value: unknown,
    recoveryFrom?: import("./input.js").CreationInputSnapshot["recoveryFrom"],
  ) {
    const owner = creationText(actor, 200),
      request = creationRequest(value),
      signature = creationRequestDigest(recoveryFrom ? { request, recoveryFrom } : request);
    await this.authority.authorize(owner, request.projectId);
    const prior = await this.tasks.find(owner, request.id);
    if (prior) {
      const saved = await this.inputs.read(prior.spec);
      if (saved.requestDigest !== signature) throw new CreationError("conflict");
      await this.authority.authorize(owner, request.projectId);
      return prior;
    }
    await this.authority.target(owner, request);
    let previous: import("./input.js").CreationInputSnapshot["previous"];
    let previousAsset: import("./input.js").CreationInputSnapshot["previousAsset"];
    let documentFileLineage: string | undefined;
    let document: import("../../shared/documents/contracts.js").DocumentRevisionReference | undefined;
    let documentProjectId: string | undefined, documentTreeVersion: number | undefined;
    let recoveredProfile: CreationEngineProfile | undefined;
    if (request.previousTaskId) {
      const task = await this.tasks.find(owner, request.previousTaskId);
      if (!task || task.spec.projectId !== request.projectId) throw new CreationError("notFound");
      await this.authority.authorize(owner, task.spec.projectId);
      const recovery = recoveryFrom?.taskId === task.spec.id && recoveryFrom.inputDigest === task.spec.inputDigest;
      if (!recovery && (task.state !== "succeeded" || !task.artifact || !task.outputDigest))
        throw new CreationError("conflict");
      const input = await this.inputs.read(task.spec);
      documentFileLineage = input.documentFileLineage;
      if (recovery) recoveredProfile = input.profile;
      let source = task,
        saved = source.artifact ?? (await this.savedArtifact?.(owner, source.spec.id));
      for (let depth = 0; !saved && !source.spec.target.document && depth < 32; depth++) {
        if (!source.spec.previousTaskId) break;
        const parent = await this.tasks.find(owner, source.spec.previousTaskId);
        if (!parent || parent.spec.projectId !== task.spec.projectId) throw new CreationError("notFound");
        source = parent;
        saved = source.artifact ?? (await this.savedArtifact?.(owner, source.spec.id));
      }
      if (saved && saved.kind !== "document") {
        if (request.outputType === undefined || !this.authority.original) throw new CreationError("unavailable");
        previousAsset = {
          taskId: source.spec.id,
          prompt: input.prompt,
          artifact: await this.authority.original(owner, saved),
        };
        documentFileLineage = request.id;
      } else {
        if (!this.authority.revision) throw new CreationError("unavailable");
        const documentId =
          (saved?.kind === "document" ? saved.documentId : undefined) || source.spec.target.document?.documentId;
        if (!documentId) throw new CreationError("conflict");
        const current = await this.authority.revision(
          owner,
          source.spec.target.documentProjectId ?? source.spec.projectId,
          documentId,
        );
        previous = { prompt: input.prompt, document: current.document };
        document = current.base;
        documentProjectId = current.projectId;
        documentTreeVersion = current.treeVersion;
      }
    }
    const permitted = await this.authority.profile(
      request.profileId,
      recoveryFrom ? undefined : { model: request.model, effort: request.effort },
    );
    if (recoveredProfile && recoveredProfile.engineId !== permitted.engineId) throw new CreationError("unavailable");
    const profile = structuredClone(recoveredProfile || permitted);
    if (profile.id !== request.profileId) throw new CreationError("unavailable");
    const skills = await this.authority.capture(owner, request, signature);
    if (request.attachments?.length && !this.materials) throw new CreationError("unavailable");
    const materials = request.attachments?.length ? await this.materials!.prepare(owner, request.attachments) : [];
    const inputDigest = await this.inputs.put({
      schema: 1,
      taskId: request.id,
      owner,
      projectId: request.projectId,
      requestDigest: signature,
      prompt: request.prompt,
      ...(request.outputType === undefined ? {} : { outputType: request.outputType }),
      profile,
      skills,
      ...(materials.length ? { materials } : {}),
      ...(previous ? { previous } : {}),
      ...(previousAsset ? { previousAsset } : {}),
      ...(documentFileLineage ? { documentFileLineage } : {}),
      ...(recoveryFrom ? { recoveryFrom } : {}),
    });
    await this.authority.authorize(owner, request.projectId);
    try {
      return await this.tasks.create(
        {
          schema: 1,
          id: request.id,
          owner,
          projectId: request.projectId,
          operationId: creationOperation(owner, request.id),
          kind: request.outputType ?? "document",
          target: {
            parentId: request.parentId,
            treeVersion: documentTreeVersion ?? request.treeVersion,
            locale: request.locale,
            ...(document ? { document } : {}),
            ...(documentProjectId ? { documentProjectId } : {}),
          },
          inputDigest,
          skillCaptureId: skills.id,
          ...(request.previousTaskId ? { previousTaskId: request.previousTaskId } : {}),
        },
        this.now(),
      );
    } catch (error) {
      if (!(error instanceof CreationError) || error.code !== "conflict") throw error;
      const accepted = await this.tasks.find(owner, request.id);
      if (!accepted || (await this.inputs.read(accepted.spec)).requestDigest !== signature) throw error;
      await this.authority.authorize(owner, request.projectId);
      return accepted;
    }
  }
}
