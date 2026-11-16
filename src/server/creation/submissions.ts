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
  profile(id: string): Promise<CreationEngineProfile>;
  capture(owner: string, request: CreationRequest, requestDigest: string): Promise<SkillCapture>;
}
/** Submission is idempotent before mutable catalogs are consulted. Only the first accepted input snapshot enters the queue. */
export class CreationSubmissions {
  constructor(
    private readonly tasks: CreationSubmissionTasks,
    private readonly inputs: CreationInputs,
    private readonly authority: CreationSubmissionAuthority,
    private readonly now: () => number = Date.now,
    private readonly output?: {
      read(digest: string): Promise<NonNullable<import("./input.js").CreationInputSnapshot["previous"]>["document"]>;
    },
  ) {}
  async followUp(owner: string, id: string, value: unknown) {
    const request = creationRecord(value, ["id", "prompt"]),
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
      selections: input.skills.composition.skills.map(({ packageId, version, digest, id, parameters }) => ({
        packageId,
        version,
        digest,
        id,
        parameters,
      })),
    });
  }
  async submit(actor: string, value: unknown) {
    const owner = creationText(actor, 200),
      request = creationRequest(value),
      signature = creationRequestDigest(request);
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
    if (request.previousTaskId) {
      const task = await this.tasks.find(owner, request.previousTaskId);
      if (!task || task.spec.projectId !== request.projectId) throw new CreationError("notFound");
      await this.authority.authorize(owner, task.spec.projectId);
      if (task.state !== "succeeded" || !task.artifact || !task.outputDigest || !this.output)
        throw new CreationError("conflict");
      const input = await this.inputs.read(task.spec);
      previous = { prompt: input.prompt, document: await this.output.read(task.outputDigest) };
    }
    const profile = structuredClone(await this.authority.profile(request.profileId));
    if (profile.id !== request.profileId) throw new CreationError("unavailable");
    const skills = await this.authority.capture(owner, request, signature);
    const inputDigest = await this.inputs.put({
      schema: 1,
      taskId: request.id,
      owner,
      projectId: request.projectId,
      requestDigest: signature,
      prompt: request.prompt,
      profile,
      skills,
      ...(previous ? { previous } : {}),
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
          kind: "document",
          target: {
            parentId: request.parentId,
            treeVersion: request.treeVersion,
            locale: request.locale,
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
