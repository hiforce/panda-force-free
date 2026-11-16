import type { KnowledgeTaskInput, KnowledgeDialogue, KnowledgePrevious } from "../../../shared/knowledge/tasks.js";
import type { KnowledgeEvidenceSource } from "../../../shared/knowledge/contracts.js";
import type { KnowledgeTaskFiles } from "./contracts.js";
import { knowledgeContext } from "./input.js";
import { readTaskPrevious, previousRecord } from "./previous.js";
import { knowledgeMarkdown } from "./markdown.js";
import { KNOWLEDGE_LIMITS } from "../../../shared/knowledge/tasks.js";
import { KnowledgeTaskError } from "./contracts.js";

export const previousSourceId = (input: KnowledgeTaskInput) => "previous-" + input.target.id;
/** Human-owned prior knowledge is historical user context, never a current original asset or a source fact. */
export async function taskKnowledgeContext(
  files: Pick<KnowledgeTaskFiles, "previous">,
  input: KnowledgeTaskInput,
  dialogue: KnowledgeDialogue,
): Promise<KnowledgeEvidenceSource[]> {
  return knowledgeContextWithPrevious(input, dialogue, await readTaskPrevious(files, input));
}
export function knowledgeContextWithPrevious(
  input: KnowledgeTaskInput,
  dialogue: KnowledgeDialogue,
  previous: KnowledgePrevious | null,
): KnowledgeEvidenceSource[] {
  const context = knowledgeContext(input, dialogue);
  if (previous && input.target.previous?.reviewRequired) {
    const record = previousRecord(previous);
    context.push({
      id: previousSourceId(input),
      version: input.target.previous.state,
      kind: "user-input",
      title: record?.draft.title ?? input.sources[0]!.title,
      text: previous.markdown ?? knowledgeMarkdown(record!),
      sections: [],
    });
  }
  if (context.reduce((sum, source) => sum + source.text.length, 0) > KNOWLEDGE_LIMITS.contextCharacters)
    throw new KnowledgeTaskError("contextLimit");
  return context;
}
