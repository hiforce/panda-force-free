import type { KnowledgeTaskInput, KnowledgeRecord } from "../../../shared/knowledge/tasks.js";
import type { DocumentProjectReads } from "../../documents/files/projects.js";
import { knowledgeRecord } from "../tasks/record.js";
import { knowledgeOutputCommand } from "./output-command.js";
import { fileKnowledgeProjection } from "./catalog-projection.js";

/** A trusted recovery port can inspect only this exact approved operation; it cannot plan or create a mutation. */
export async function recoverKnowledgeOutput(
  projects: DocumentProjectReads,
  owner: string,
  input: KnowledgeTaskInput,
  value: KnowledgeRecord,
  missing?: () => Promise<void>,
) {
  const record = knowledgeRecord(value),
    command = knowledgeOutputCommand(owner, input, record),
    project = await projects.ifPresent(input.scope.project, async (project) => project);
  if (!project) {
    await missing?.();
    return null;
  }
  const previous = await project.coordinator.plannedReceipt(command, missing);
  if (!previous) return null;
  const receipt = { id: record.id, version: record.version, commit: previous.commit },
    projection = await fileKnowledgeProjection(projects, input, record, receipt);
  return { receipt, projection };
}
