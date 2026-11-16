import { knowledgeSourcePath } from "./source-context.js";
import type { KnowledgeTaskInput, KnowledgeRecord, KnowledgeReceipt } from "../../../shared/knowledge/tasks.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { DocumentProjectReads } from "../../documents/files/projects.js";
import { ProjectGitSnapshots } from "../../project-content/git/snapshot.js";
import { projectBlobHash } from "../../project-content/git/blob-hash.js";
import { projectKnowledgeFile, projectKnowledgeMarkdown } from "../../project-content/paths.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { knowledgeCatalogProjection } from "../../../shared/knowledge/catalog.js";
import { knowledgeRecord } from "../tasks/record.js";
import { knowledgeMarkdown } from "./markdown.js";

/** Saved Git object identities make subsequent source checks cheap without treating metadata as approval authority. */
export async function fileKnowledgeProjection(
  projects: DocumentProjectReads,
  input: KnowledgeTaskInput,
  value: KnowledgeRecord,
  receipt: KnowledgeReceipt,
) {
  const record = knowledgeRecord(value);
  if (
    record.id !== input.target.id ||
    record.id !== receipt.id ||
    record.version !== receipt.version ||
    record.previousVersion !== input.target.expectedVersion ||
    record.sourceCommit !== input.sourceCommit
  )
    throw new KnowledgeTaskError("conflict");
  await projects.authorize(input.scope.project);
  const result = await projects.ifPresent(input.scope.project, async (project, view) => {
    const snapshots = new ProjectGitSnapshots(project.owned),
      original = new Map((await snapshots.entries(input.sourceCommit)).map((entry) => [entry.path, entry.blob])),
      saved = new Map((await snapshots.entries(receipt.commit)).map((entry) => [entry.path, entry.blob])),
      recordBlob = projectBlobHash(Buffer.from(stableJson(record) + "\n")),
      markdownBlob = projectBlobHash(Buffer.from(knowledgeMarkdown(record)));
    if (
      saved.get(projectKnowledgeFile(record.id)) !== recordBlob ||
      saved.get(projectKnowledgeMarkdown(record.id)) !== markdownBlob
    )
      throw new KnowledgeTaskError("conflict");
    const sources = record.sources
      .filter((source) => source.kind === "asset")
      .map((source) => {
        const captured = input.sources.find((item) => item.id === source.id);
        if (!captured || captured.kind !== "asset" || captured.version !== source.version)
          throw new KnowledgeTaskError("conflict");
        const blob = original.get(knowledgeSourcePath(captured));
        if (
          !blob ||
          stableJson(captured.binding ?? null) !== stableJson(source.binding ?? null) ||
          (source.binding && source.binding.blob !== blob)
        )
          throw new KnowledgeTaskError("conflict");
        return {
          id: source.id,
          version: source.version,
          blob,
          ...(source.binding ? { binding: structuredClone(source.binding) } : {}),
        };
      });
    view.assertHeld();
    return knowledgeCatalogProjection({
      schema: 1,
      id: record.id,
      version: record.version,
      taskId: record.taskId,
      sourceCommit: record.sourceCommit,
      recordBlob,
      markdownBlob,
      sources,
    });
  });
  if (result === null) throw new KnowledgeTaskError("notFound");
  return result;
}
