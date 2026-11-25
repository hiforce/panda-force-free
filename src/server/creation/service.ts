import { creationDocumentArtifact } from "../../shared/creation/contracts.js";
import {
  CREATION_NOTIFICATION_PAGE_SIZE,
  CREATION_NOTIFICATION_PREVIEW_SIZE,
  creationNotificationCursor,
  type CreationNotificationPosition,
} from "../../shared/creation/notifications.js";
import type { CreationResult } from "./ports.js";
import type { CreationAvailability, CreationTaskView } from "../../shared/creation/contracts.js";
import type { CreationInputs } from "./input.js";
import type { CreationTask } from "./contracts.js";
import type { CreationSubmissions } from "./submissions.js";
import type { CreationQuestions } from "./questions/service.js";
import { creationHistoryCommand } from "./history/contracts.js";
import { CreationError } from "./contracts.js";
import { creationGoalCommand, creationGoalView } from "./goals/contracts.js";
import { creationId, creationUuid, creationRecord, creationInteger } from "./validation.js";
import type { CreationProgressStore } from "./ports.js";
import type { CreationTaskDetail } from "../../shared/creation/contracts.js";

export interface CreationManagement extends Partial<import("./ports.js").CreationNotificationStore> {
  get(owner: string, id: string): CreationResult<CreationTask>;
  cancel(owner: string, id: string, now: number): CreationResult<CreationTask>;
}
export interface CreationHistory {
  rounds?(
    owner: string,
    id: string,
    cursor?: string,
  ): CreationResult<import("./history/contracts.js").CreationRoundPage>;
  list(owner: string, projectId?: string): CreationResult<CreationTask[]>;
  clearHistory?(
    owner: string,
    command: import("./history/contracts.js").CreationHistoryCommand,
    now: number,
  ): CreationResult<import("./history/contracts.js").CreationHistoryReceipt>;
  retry(owner: string, id: string, operationId: string, now: number): CreationResult<CreationTask>;
}
/** HTTP and future command adapters use the same authorized task operations; internal leases never become browser state. */
export class CreationService {
  private closed = false;
  private readonly summaries = new Map<
    string,
    Promise<{ prompt: string; runtimeId?: string; model: string | null; effort: string | null; documentTitle?: string }>
  >();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly tasks: CreationManagement,
    private readonly history: CreationHistory,
    private readonly submissions: CreationSubmissions,
    private readonly inputs: CreationInputs,
    private readonly questions: CreationQuestions,
    private readonly authorize: (owner: string, projectId: string) => Promise<void>,
    private readonly availability: () => Promise<CreationAvailability>,
    private readonly runtime: { wake(): CreationResult<void>; interrupt(owner: string, id: string): void },
    private readonly now: () => number = Date.now,
    private readonly progress?: CreationProgressStore,
    private readonly messages?: import("./messages/service.js").CreationMessages,
    private readonly describeSkills?: (
      selections: readonly import("../../shared/creation/contracts.js").CreationSkillSelection[],
    ) => Promise<import("../../shared/session-skills.js").SessionSkillSummary[]>,
    private readonly goals?: import("./goals/contracts.js").CreationGoalStore,
    private readonly workspaces?: import("./workspaces.js").CreationWorkspaces,
    private readonly documentLocation?: import("./integration/document-port.js").CreationDocumentPort["location"],
    private readonly savedArtifact?: (
      owner: string,
      id: string,
    ) => Promise<import("./contracts.js").CreationArtifact | null>,
    private readonly fileLocation?: (
      task: import("./contracts.js").CreationTaskSpec,
    ) => Promise<NonNullable<import("./contracts.js").CreationDocumentArtifact["file"]> | null>,
  ) {}
  private using<T>(work: () => Promise<T>) {
    if (this.closed) return Promise.reject(new CreationError("unavailable"));
    const result = Promise.resolve().then(work);
    this.pending.add(result);
    return result.finally(() => this.pending.delete(result));
  }
  options() {
    return this.using(this.availability);
  }
  notifications(owner: string, query?: "preview" | { before?: CreationNotificationPosition }) {
    return this.using(async () => {
      const items: import("../../shared/creation/contracts.js").CreationNotification[] = [];
      const notification = async (record: import("./ports.js").CreationNotificationRecord) => {
        const task = await this.tasks.get(owner, record.taskId);
        if (task.state !== "succeeded" || !task.artifact) return;
        try {
          await this.authorize(owner, task.spec.projectId);
          if (task.artifact.projectId !== task.spec.projectId) await this.authorize(owner, task.artifact.projectId);
        } catch {
          return;
        }
        let artifact = task.artifact;
        if (artifact.kind === "document" && this.documentLocation) {
          const location = await this.documentLocation(
            owner,
            task.spec.target.documentProjectId ?? task.spec.projectId,
            artifact.documentId,
          );
          if (!location) return;
          try {
            await this.authorize(owner, location.projectId);
          } catch {
            return;
          }
          artifact = { ...artifact, projectId: location.projectId };
        }
        items.push({ ...record, title: artifact.title ?? "", kind: artifact.kind, artifact });
      };
      if (query && query !== "preview") {
        let before = query.before;
        const limit = CREATION_NOTIFICATION_PAGE_SIZE + 1;
        while (items.length < limit) {
          const records = (await this.tasks.notifications?.(owner, { before, limit })) ?? [];
          for (const record of records) {
            await notification(record);
            if (items.length === limit) break;
          }
          if (records.length < limit) break;
          before = records.at(-1);
        }
        const page = items.slice(0, CREATION_NOTIFICATION_PAGE_SIZE);
        return { items: page, nextCursor: items.length === limit ? creationNotificationCursor(page.at(-1)!) : null };
      }
      for (const record of (await this.tasks.notifications?.(owner)) ?? []) await notification(record);
      return {
        items: query === "preview" ? items.slice(0, CREATION_NOTIFICATION_PREVIEW_SIZE) : items,
        unreadCount: items.filter((item) => item.readAt === null).length,
      };
    });
  }
  readNotification(owner: string, value: unknown) {
    return this.using(async () => {
      if (!this.tasks.readNotification) throw new CreationError("unavailable");
      const input = creationRecord(value, ["taskId", "generation"]),
        id = creationUuid(input.taskId),
        generation = creationInteger(input.generation);
      const task = await this.tasks.get(owner, id);
      await this.authorize(owner, task.spec.projectId);
      if (task.artifact && task.artifact.projectId !== task.spec.projectId)
        await this.authorize(owner, task.artifact.projectId);
      await this.tasks.readNotification(owner, id, generation, this.now());
      return { taskId: id, generation, read: true };
    });
  }
  private async summary(owner: string, task: CreationTask) {
    const cacheKey = JSON.stringify([owner, task.spec.inputDigest]);
    let summary = this.summaries.get(cacheKey);
    if (!summary) {
      summary = this.inputs.read(task.spec).then((input) => ({
        prompt: input.prompt,
        runtimeId: input.profile.runtimeId ?? "codex",
        model: input.profile.model ?? null,
        effort: input.profile.effort ?? null,
        documentTitle: input.previous?.document.title,
      }));
      this.summaries.set(cacheKey, summary);
      const failed = summary;
      void summary.catch(() => {
        if (this.summaries.get(cacheKey) === failed) this.summaries.delete(cacheKey);
      });
      while (this.summaries.size > 128) this.summaries.delete(this.summaries.keys().next().value!);
    }
    return summary;
  }
  private async identity(
    owner: string,
    reference: NonNullable<import("./history/contracts.js").CreationHistoryTask["history"]>,
  ) {
    const root = await this.tasks.get(owner, reference.rootId);
    await this.authorize(owner, root.spec.projectId);
    const input = await this.summary(owner, root);
    return { id: root.spec.id, prompt: input.prompt, createdAt: root.createdAt, rounds: reference.rounds };
  }
  rounds(owner: string, id: string, cursor?: string) {
    return this.using(async (): Promise<import("../../shared/creation/contracts.js").CreationConversationPage> => {
      const task = await this.tasks.get(owner, creationUuid(id));
      await this.authorize(owner, task.spec.projectId);
      if (!this.history.rounds) throw new CreationError("unavailable");
      const page = await this.history.rounds(owner, id, cursor);
      const creation = await this.identity(owner, {
        rootId: page.rootId,
        createdAt: page.createdAt,
        rounds: page.rounds,
      });
      await this.authorize(owner, task.spec.projectId);
      return { creation, latestTaskId: page.latestTaskId, ids: page.ids, nextCursor: page.nextCursor };
    });
  }
  private async view(owner: string, task: CreationTask): Promise<CreationTaskView> {
    await this.authorize(owner, task.spec.projectId);
    const input = await this.summary(owner, task),
      question = ["running", "queued"].includes(task.state) ? await this.questions.pending(owner, task.spec.id) : null;
    await this.authorize(owner, task.spec.projectId);
    const goalEvent = (await this.goals?.read(owner, task.spec.id)) || null;
    const current = await this.tasks.get(owner, task.spec.id);
    const primary =
      current.artifact ??
      (current.state === "committing" && current.outputDigest && current.failure
        ? await this.savedArtifact?.(owner, current.spec.id)
        : null);
    const documentArtifact = creationDocumentArtifact(primary),
      documentTarget = !primary || primary.kind === "document" ? current.spec.target.document : undefined;
    const documentId = documentArtifact?.documentId ?? documentTarget?.documentId;
    const location =
      documentId && this.documentLocation
        ? await this.documentLocation(
            owner,
            current.spec.target.documentProjectId ?? current.spec.projectId,
            documentId,
          )
        : undefined;
    return {
      ...((task as import("./history/contracts.js").CreationHistoryTask).history
        ? {
            creation: await this.identity(
              owner,
              (task as import("./history/contracts.js").CreationHistoryTask).history!,
            ),
          }
        : {}),
      goal: creationGoalView(goalEvent, current),
      id: current.spec.id,
      projectId: current.spec.projectId,
      state: current.state,
      generation: current.generation,
      prompt: input.prompt,
      outputType: current.spec.kind,
      runtimeId: input.runtimeId,
      model: input.model,
      effort: input.effort,
      artifact: current.artifact,
      ...(documentId && this.documentLocation
        ? { documentStatus: location ? ("available" as const) : ("unavailable" as const) }
        : {}),
      failure: current.failure,
      cancelRequested: current.cancelRequested,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      ...(current.spec.previousTaskId ? { previousTaskId: current.spec.previousTaskId } : {}),
      ...(documentId && this.documentLocation
        ? {
            document: {
              documentId,
              ...(location
                ? {
                    projectId: location.projectId,
                    ...(location.projectName ? { projectName: location.projectName } : {}),
                  }
                : {}),
              title: primary?.title || input.documentTitle || input.prompt.slice(0, 100),
              revision: documentArtifact?.revision || documentTarget?.version || 1,
            },
          }
        : documentTarget
          ? {
              document: {
                documentId: documentTarget.documentId,
                title: current.artifact?.title || input.documentTitle || input.prompt.slice(0, 100),
                revision: creationDocumentArtifact(current.artifact)?.revision || documentTarget.version,
              },
            }
          : {}),
      question:
        question &&
        question.generation === current.generation &&
        !current.cancelRequested &&
        ["running", "queued"].includes(current.state)
          ? { id: question.id, questions: question.questions }
          : null,
    };
  }
  submit(owner: string, value: unknown) {
    return this.using(async () => {
      const task = await this.submissions.submit(owner, value);
      this.runtime.wake();
      return this.view(owner, task);
    });
  }
  clearHistory(owner: string, value: unknown) {
    return this.using(async () => {
      const command = creationHistoryCommand(value);
      if (!this.history.clearHistory) throw new CreationError("unavailable");
      if (command.taskId) {
        const task = await this.tasks.get(owner, command.taskId);
        await this.authorize(owner, task.spec.projectId);
      }
      return this.history.clearHistory(owner, command, this.now());
    });
  }
  list(owner: string, projectId: string) {
    return this.using(async () => {
      const all = projectId === "*";
      if (!all) {
        creationId(projectId);
        await this.authorize(owner, projectId);
      }
      const tasks = (await this.history.list(owner, all ? undefined : projectId)).slice(0, 50);
      const views = await Promise.all(
        tasks.map(async (task) => {
          try {
            return await this.view(owner, task);
          } catch (error) {
            if (all && error instanceof CreationError && error.code === "notFound") return null;
            throw error;
          }
        }),
      );
      return views.filter((task): task is CreationTaskView => task !== null);
    });
  }
  detail(owner: string, id: string, conversation = true) {
    return this.using(async (): Promise<CreationTaskDetail> => {
      const task = await this.view(owner, await this.tasks.get(owner, creationUuid(id))),
        [progress, clarifications] = await Promise.all([
          this.progress?.list(owner, id, conversation) ?? [],
          conversation ? this.questions.historyDetails(owner, id) : [],
        ]);
      await this.authorize(owner, task.projectId);
      const input = await this.inputs.read((await this.tasks.get(owner, id)).spec);
      const messages = conversation ? (await this.messages?.public(owner, id)) || [] : [];
      await this.authorize(owner, task.projectId);
      const selections = input.skills.composition.skills
        .filter((skill) => !(skill.packageId === "panda-force.document-creation" && skill.id === "writing"))
        .map(({ packageId, version, digest, id, parameters }) => ({ packageId, version, digest, id, parameters }));
      const summaries = await this.describeSkills?.(selections);
      const goalEvent = (await this.goals?.read(owner, id)) || null;
      const current = await this.tasks.get(owner, id);
      const workspace = await this.workspaces?.lookup(owner, id);
      const file =
        task.artifact?.kind === "document" && this.fileLocation
          ? await this.fileLocation(current.spec).catch(() => null)
          : undefined;
      const presentedMessages = await Promise.all(
        messages.map(async (message) => ({
          ...message,
          skillSummaries: await this.describeSkills?.(message.selections),
        })),
      );
      await this.authorize(owner, task.projectId);
      return {
        ...task,
        ...(task.artifact?.kind === "document" && file !== undefined
          ? { artifact: { ...task.artifact, file: file ?? undefined } }
          : {}),
        ...(workspace ? { workspaceDirectory: workspace.path } : {}),
        goal: creationGoalView(goalEvent, task),
        goalVersion: goalEvent?.at || 0,
        progress,
        clarifications,
        messages: presentedMessages,
        selections,
        skillSummaries: summaries,
        attachments: (input.materials || []).map((material) => ({
          id: material.id,
          materialId: material.id,
          name: material.name,
          kind: material.kind,
          status: "ready",
          url: "/api/creation-materials/original?id=" + material.id,
        })),
        usage: progress.toReversed().find((event) => event.stage === "usage")?.usage,
      };
    });
  }
  goal(owner: string, id: string, value: unknown) {
    const command = creationGoalCommand(structuredClone(value));
    return this.using(async () => {
      if (!this.goals) throw new CreationError("unavailable");
      const original = await this.tasks.get(owner, creationUuid(id));
      await this.authorize(owner, original.spec.projectId);
      let task = original;
      if (["set", "create"].includes(command.action) && original.artifact && original.state === "succeeded") {
        await this.goals.check(owner, command.id, command);
        const last = (await this.messages?.public(owner, id))?.at(-1);
        task = await this.submissions.followUp(owner, id, {
          id: command.id,
          prompt: command.objective,
          ...(command.runtimeId === undefined ? {} : { runtimeId: command.runtimeId }),
          ...(command.model === undefined ? {} : { model: command.model }),
          ...(command.effort === undefined ? {} : { effort: command.effort }),
          ...(last ? { selections: last.selections } : {}),
        });
      }
      const event = await this.goals.command(owner, task.spec.id, command, this.now());
      if (command.action === "pause") this.runtime.interrupt(owner, task.spec.id);
      else this.runtime.wake();
      await this.authorize(owner, task.spec.projectId);
      return {
        task: await this.view(owner, await this.tasks.get(owner, task.spec.id)),
        goal: creationGoalView(event, await this.tasks.get(owner, task.spec.id)),
      };
    });
  }
  followUp(owner: string, id: string, value: unknown) {
    return this.using(async () => {
      const task = await this.submissions.followUp(owner, creationUuid(id), value);
      this.runtime.wake();
      return this.view(owner, task);
    });
  }
  message(owner: string, id: string, value: unknown) {
    const frozen = structuredClone(value);
    return this.using(async () => {
      const task = await this.tasks.get(owner, creationUuid(id));
      await this.authorize(owner, task.spec.projectId);
      if (this.messages && (await this.messages.submit(owner, id, frozen, true))) return this.view(owner, task);
      if (
        !(frozen && typeof frozen === "object" && Object.hasOwn(frozen, "updateGeneration")) &&
        ((task.artifact && task.state === "succeeded") || task.state === "replied")
      ) {
        const next = await this.submissions.followUp(owner, id, frozen);
        this.runtime.wake();
        return this.view(owner, next);
      }
      if (!this.messages) throw new CreationError("unavailable");
      await this.messages.submit(owner, id, frozen);
      return this.view(owner, await this.tasks.get(owner, id));
    });
  }
  cancel(owner: string, id: string) {
    return this.using(async () => {
      const task = await this.tasks.get(owner, creationUuid(id));
      await this.authorize(owner, task.spec.projectId);
      const cancelled = await this.tasks.cancel(owner, id, this.now());
      this.runtime.interrupt(owner, id);
      return this.view(owner, cancelled);
    });
  }
  retry(owner: string, id: string, operationId: string) {
    return this.using(async () => {
      const task = await this.tasks.get(owner, creationUuid(id));
      await this.authorize(owner, task.spec.projectId);
      if (
        !task.artifact &&
        task.failure === "targetChanged" &&
        (task.spec.target.document || task.spec.previousTaskId)
      ) {
        const recovered = await this.submissions.recover(owner, id, operationId);
        const goal = await this.goals?.read(owner, id);
        if (goal?.goal)
          await this.goals!.command(
            owner,
            recovered.spec.id,
            { id: operationId, action: "set", objective: goal.goal.objective },
            this.now(),
          );
        this.runtime.wake();
        return this.view(owner, recovered);
      }
      const goal = await this.goals?.read(owner, id);
      if (goal?.goal) await this.goals!.command(owner, id, { id: operationId, action: "resume" }, this.now());
      const retried = goal?.goal
        ? await this.tasks.get(owner, id)
        : await this.history.retry(owner, id, operationId, this.now());
      this.runtime.wake();
      return this.view(owner, retried);
    });
  }
  answer(owner: string, id: string, value: unknown) {
    return this.using(async () => {
      const result = await this.questions.answer(owner, creationUuid(id), value);
      this.runtime.wake();
      return this.view(owner, await this.tasks.get(owner, result.taskId));
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
