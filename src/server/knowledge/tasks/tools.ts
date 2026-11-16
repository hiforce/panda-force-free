import type { MetadataStore } from "../metadata-ports.js";
import { knowledgeDraftSchema } from "../../../shared/knowledge/schema.js";
import { KnowledgeError } from "../../../shared/knowledge/contracts.js";
import { randomUUID } from "node:crypto";
import type {
  ApplicationRunScope,
  ApplicationToolDefinition,
  ApplicationToolCall,
} from "../../../shared/engine/application-tools.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import {
  knowledgeObject,
  knowledgeId,
  knowledgeText,
  knowledgeDialogue,
} from "../../../shared/knowledge/task-validation.js";
import { taskKnowledgeContext } from "./evidence-context.js";
import { knowledgeTextChunk } from "./context.js";
import { validateKnowledgeEvidence } from "../evidence.js";
import {
  KnowledgeTaskError,
  type KnowledgeLease,
  type KnowledgeExecution,
  type KnowledgeTaskFiles,
  type KnowledgeContent,
} from "./contracts.js";
import type { KnowledgeTaskStore } from "./contracts.js";
export const knowledgeTools: readonly ApplicationToolDefinition[] = [
  {
    name: "panda_knowledge_context",
    description:
      "Read a selected immutable evidence source. Only source IDs from this task's manifest are available. Offsets are UTF-16 indices in its exact text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "start"],
      properties: { id: { type: "string", maxLength: 128 }, start: { type: "integer", minimum: 0 } },
    },
  },
  {
    name: "panda_knowledge_ask",
    description:
      "Ask the user for essential missing context. This durably suspends this run; a new run receives the literal answers. Do not use this for approval to save a draft.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["question", "options"],
            properties: {
              question: { type: "string", maxLength: 2000 },
              options: { type: "array", maxItems: 3, items: { type: "string", maxLength: 200 } },
            },
          },
        },
      },
    },
  },
  {
    name: "panda_knowledge_draft",
    description:
      "Submit a knowledge draft for human review. Cite exact source quotes and versions; distinguish source facts, inference and literal user input. It is saved only after user review.",
    inputSchema: knowledgeDraftSchema(),
  },
];
/** Model calls receive immutable selected data and draft authority, never file paths, credentials or write/publish tools. */
export async function knowledgeExecutionTools(options: {
  lease: KnowledgeLease;
  ledger: Pick<MetadataStore<KnowledgeTaskStore>, "assertLease" | "bind" | "assertExecution" | "question" | "draft">;
  files: KnowledgeTaskFiles;
  content: KnowledgeContent;
  now(): number;
  finished(): void;
}) {
  const { lease, ledger, files, content, now } = options,
    task = await ledger.assertLease(lease, now()),
    [input, dialogue] = await Promise.all([files.input(task.inputDigest), files.dialogue(task.dialogueDigest)]),
    context = await taskKnowledgeContext(files, input, dialogue);
  let scope: KnowledgeExecution | null = null,
    calls = 0;
  return {
    input,
    manifest: context.map(({ id, version, kind, title, text }) => ({
      id,
      version,
      kind,
      title: title.slice(0, 200),
      characters: text.length,
    })),
    dialogue,
    async started(value: ApplicationRunScope) {
      scope = await ledger.bind(lease, value, now());
    },
    async call(call: ApplicationToolCall) {
      if (!scope || call.sessionId !== scope.sessionId || call.runId !== scope.runId)
        throw new KnowledgeTaskError("leaseLost");
      await ledger.assertExecution(scope, now());
      if (++calls > 160) throw new KnowledgeTaskError("budget");
      await content.authorize(lease.owner, task.project);
      if (!(await content.current(lease.owner, input))) throw new KnowledgeError("sourceChanged", 409);
      await ledger.assertExecution(scope, now());
      if (call.name === "panda_knowledge_context") {
        const p = knowledgeObject(call.arguments, ["id", "start"]),
          id = knowledgeId(p.id),
          source = context.find((source) => source.id === id);
        if (!source) throw new KnowledgeTaskError("notFound");
        if (!Number.isSafeInteger(p.start) || Number(p.start) < 0 || Number(p.start) > source.text.length)
          throw new KnowledgeTaskError("invalidInput");
        return knowledgeTextChunk(source, Number(p.start));
      }
      if (call.name === "panda_knowledge_ask") {
        const p = knowledgeObject(call.arguments, ["questions"]);
        if (!Array.isArray(p.questions) || !p.questions.length || p.questions.length > KNOWLEDGE_LIMITS.questionCount)
          throw new KnowledgeTaskError("invalidInput");
        const questions = p.questions.map((value) => {
            const q = knowledgeObject(value, ["question", "options"]);
            if (!Array.isArray(q.options) || q.options.length > 3) throw new KnowledgeTaskError("invalidInput");
            return {
              id: randomUUID(),
              question: knowledgeText(q.question, 2000),
              options: q.options.map((value) => knowledgeText(value, 200)),
            };
          }),
          next = knowledgeDialogue({ questions: [...dialogue.questions, ...questions], answers: dialogue.answers }),
          digest = await files.putDialogue(next);
        await ledger.question(scope, digest, now());
        options.finished();
        return { state: "waiting" };
      }
      if (call.name === "panda_knowledge_draft") {
        validateKnowledgeEvidence(call.arguments, context);
        const digest = await files.putDraft(call.arguments as Parameters<KnowledgeTaskFiles["putDraft"]>[0]);
        await ledger.draft(scope, digest, now());
        options.finished();
        return { state: "review" };
      }
      throw new KnowledgeTaskError("invalidInput");
    },
  };
}
