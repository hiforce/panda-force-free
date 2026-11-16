import { knowledgeValueDigest } from "../identity.js";
import { join } from "node:path";
import { stableJson } from "../../../shared/stable-json.js";
import { knowledgeDraft } from "../../../shared/knowledge/validation.js";
import { knowledgeDialogue } from "../../../shared/knowledge/task-validation.js";
import { FilePackageContent } from "../../packages/content-store.js";
import type { KnowledgeTaskFiles } from "../tasks/contracts.js";
import { knowledgeInput } from "../tasks/input.js";
import { knowledgeRecord } from "../tasks/record.js";
import { knowledgeReviewReport } from "../../../shared/knowledge/review.js";
import { knowledgePrevious } from "../tasks/previous.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";

function content<T>(root: string, maxBytes: number, validate: (value: unknown) => T) {
  const files = new FilePackageContent<T>(root, {
    maxBytes,
    encode: async (value) => Buffer.from(stableJson(validate(value))),
    decode: async (bytes) => validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    digest: knowledgeValueDigest,
  });
  return {
    read: (digest: string) => files.read(digest),
    put: async (input: T) => {
      const value = validate(input);
      await files.put(value);
      return knowledgeValueDigest(value);
    },
  };
}

/** Separate codecs prevent a model draft from being read as an approved output or source context. */
export function knowledgeTaskFiles(root: string): KnowledgeTaskFiles {
  const inputs = content(join(root, "inputs"), 1024 * 1024, knowledgeInput),
    dialogues = content(join(root, "dialogues"), 256 * 1024, knowledgeDialogue),
    drafts = content(join(root, "drafts"), 1024 * 1024, knowledgeDraft),
    outputs = content(join(root, "outputs"), 1024 * 1024, knowledgeRecord),
    reviews = content(join(root, "reviews"), 128 * 1024, knowledgeReviewReport),
    previous = content(join(root, "previous"), KNOWLEDGE_LIMITS.previousBytes, knowledgePrevious);
  return {
    input: inputs.read,
    dialogue: dialogues.read,
    draft: drafts.read,
    output: outputs.read,
    putInput: inputs.put,
    putDialogue: dialogues.put,
    putDraft: drafts.put,
    putOutput: outputs.put,
    review: reviews.read,
    putReview: reviews.put,
    previous: previous.read,
    putPrevious: previous.put,
  };
}
