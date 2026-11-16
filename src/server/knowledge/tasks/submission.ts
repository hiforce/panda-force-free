import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeTaskInput } from "../../../shared/knowledge/tasks.js";
import {
  knowledgeId,
  knowledgeObject,
  knowledgeSelection,
  knowledgeText,
} from "../../../shared/knowledge/task-validation.js";
import { knowledgeInput } from "./input.js";
import { knowledgeValueDigest } from "../identity.js";
import { previousState, previousRequiresReview } from "./previous.js";
import { knowledgeContextWithPrevious } from "./evidence-context.js";
import {
  KnowledgeTaskError,
  type KnowledgeTaskStore,
  type KnowledgeTaskFiles,
  type KnowledgeContent,
  type KnowledgeTaskRow,
  type KnowledgeSubmissionAdmission,
  type KnowledgeSubmissionGuard,
} from "./contracts.js";
/** Submission captures immutable input independently of task inspection, human review and delivery. */
export class KnowledgeTaskSubmission {
  constructor(
    private ledger: Pick<MetadataStore<KnowledgeTaskStore>, "submission" | "create">,
    private files: KnowledgeTaskFiles,
    private content: KnowledgeContent,
    private profile: () => Promise<KnowledgeTaskInput["profile"]>,
    private execution: {
      wake(): void;
    },
    private now = () => Date.now(),
  ) {}
  async submit(owner: string, value: unknown, admission?: KnowledgeSubmissionAdmission): Promise<KnowledgeTaskRow> {
    const p = knowledgeObject(value, ["id", "project", "ids", "purpose", "contentKinds"]),
      operationId = knowledgeId(p.id),
      selection = knowledgeSelection({
        project: p.project,
        ids: p.ids,
        ...(p.contentKinds === undefined ? {} : { contentKinds: p.contentKinds }),
      }),
      purpose = knowledgeText(p.purpose ?? "", 4096, true),
      requestHash = knowledgeValueDigest({ selection, purpose }),
      commit = (assertHeld?: () => void): KnowledgeSubmissionGuard | undefined =>
        admission
          ? (id, created, now) => {
              assertHeld?.();
              const result = admission.commit(id, created, now);
              if (result instanceof Promise)
                return result.then(() => {
                  assertHeld?.();
                });
              assertHeld?.();
            }
          : undefined;
    await this.content.authorize(owner, selection.project);
    const prior = await this.ledger.submission(owner, operationId, requestHash);
    if (prior) {
      if (admission) {
        const input = await this.files.input(prior.inputDigest);
        return await admission.withSource(
          input.sourceCommit,
          async (assertHeld) =>
            await this.ledger.create(
              { ...prior, autoEligible: prior.autoEligible === 1, operationId, requestHash },
              this.now(),
              commit(assertHeld),
            ),
        );
      }
      return prior;
    }
    const [captured, profile] = await Promise.all([this.content.capture(owner, selection), this.profile()]);
    if (
      admission &&
      (selection.ids.length !== 1 ||
        selection.ids[0] !== admission.source.id ||
        captured.identities?.find((source) => source.id === admission.source.id)?.version !==
          admission.source.version ||
        (admission.source.kind !== undefined &&
          (captured.sources.find((source) => source.id === admission.source.id)?.binding?.kind ?? "document") !==
            admission.source.kind))
    )
      throw new KnowledgeTaskError("conflict");
    const previous = captured.previous
      ? {
          digest: await this.files.putPrevious(captured.previous),
          state: previousState(captured.previous),
          reviewRequired: previousRequiresReview(captured.previous),
        }
      : undefined;
    const input = knowledgeInput({
      schema: 1,
      scope: selection,
      purpose,
      sources: captured.sources,
      sourceCommit: captured.commit,
      profile,
      target: { ...captured.target, ...(previous ? { previous } : {}) },
    });
    knowledgeContextWithPrevious(input, { questions: [], answers: [] }, captured.previous ?? null);
    const [inputDigest, dialogueDigest] = await Promise.all([
      this.files.putInput(input),
      this.files.putDialogue({ questions: [], answers: [] }),
    ]);
    await this.content.authorize(owner, selection.project);
    const create = async (assertHeld?: () => void) =>
      await this.ledger.create(
        {
          owner,
          project: selection.project,
          title: input.sources[0]!.title,
          operationId,
          requestHash,
          signature: knowledgeValueDigest({ ...input, sourceCommit: "" }),
          inputDigest,
          dialogueDigest,
          autoEligible: !previous?.reviewRequired,
        },
        this.now(),
        commit(assertHeld),
      );
    const task = admission ? await admission.withSource(input.sourceCommit, create) : await create();
    this.execution.wake();
    return task;
  }
}
