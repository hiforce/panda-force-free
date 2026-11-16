import { ProjectGitSnapshots } from "../../project-content/git/snapshot.js";
import { createHash } from "node:crypto";
import type { KnowledgeTaskInput, KnowledgeSelection, KnowledgeRecord } from "../../../shared/knowledge/tasks.js";
import { knowledgeSelection } from "../../../shared/knowledge/task-validation.js";
import { stableJson } from "../../../shared/stable-json.js";
import { DocumentError } from "../../documents/errors.js";
import type { DocumentFileProjects } from "../../documents/files/projects.js";
import { projectKnowledgeFile, projectKnowledgeMarkdown } from "../../project-content/paths.js";
import { knowledgeRecord } from "../tasks/record.js";
import { KnowledgeWriteConflict, type KnowledgeContent } from "../tasks/contracts.js";
import { knowledgeMarkdown } from "./markdown.js";
import { fileKnowledgeProjection } from "./catalog-projection.js";
import type { KnowledgeReceipt } from "../../../shared/knowledge/tasks.js";
import { capturePreviousKnowledge } from "./previous-content.js";
import { previousRecord, previousRequiresReview, previousState } from "../tasks/previous.js";
import { KnowledgeSourceContext, knowledgeSourcePath } from "./source-context.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import { knowledgeOutputCommand } from "./output-command.js";
import { recoverKnowledgeOutput } from "./output-recovery.js";
/** The writer rechecks saved source versions and the previous knowledge version inside the project's Git lease. */
export class FileDocumentKnowledgeContent implements KnowledgeContent {
  private readonly sources: KnowledgeSourceContext;
  constructor(
    private readonly projects: DocumentFileProjects,
    private readonly recoveryProjects = projects,
    originals?: FileOriginalQueries,
  ) {
    this.sources = new KnowledgeSourceContext(originals);
  }
  async authorize(_owner: string, project: string) {
    await this.projects.authorize(project);
  }
  async capture(_owner: string, value: KnowledgeSelection) {
    const selection = knowledgeSelection(value),
      prepared = await this.sources.prepare(selection);
    return this.projects.view(selection.project, async (project, view) => {
      const sources = await this.sources.read(view, project.owned, selection, prepared),
        id = "k-" + createHash("sha256").update(selection.ids.join("\n")).digest("hex"),
        previous = await capturePreviousKnowledge(view, id);
      return {
        commit: view.commit,
        sources,
        identities: sources.map((source) => ({ id: source.id, version: view.version(knowledgeSourcePath(source))! })),
        target: { id, expectedVersion: previous ? (previousRecord(previous)?.version ?? null) : null },
        ...(previous ? { previous } : {}),
      };
    });
  }
  async current(_owner: string, input: KnowledgeTaskInput) {
    try {
      const prepared = await this.sources.prepare(input.scope);
      return await this.projects.view(input.scope.project, (project, view) =>
        this.sources.unchanged(view, project.owned, input, new ProjectGitSnapshots(project.owned), prepared),
      );
    } catch (error) {
      if (error instanceof DocumentError && error.code === "notFound") return false;
      throw error;
    }
  }
  projection(_owner: string, input: KnowledgeTaskInput, record: KnowledgeRecord, receipt: KnowledgeReceipt) {
    return fileKnowledgeProjection(this.projects, input, record, receipt);
  }
  recover(owner: string, input: KnowledgeTaskInput, value: KnowledgeRecord, missing?: () => Promise<void>) {
    return recoverKnowledgeOutput(this.recoveryProjects, owner, input, value, missing);
  }
  async save(
    owner: string,
    input: KnowledgeTaskInput,
    value: KnowledgeRecord,
    assertAdmitted?: () => void | Promise<void>,
  ) {
    const record = knowledgeRecord(value),
      command = knowledgeOutputCommand(owner, input, record);
    const result = await this.projects.write(input.scope.project, async (project) => {
      // Receipt replay precedes consulting originals that may have since changed or been deleted.
      const previous = await project.coordinator.plannedReceipt(command);
      if (previous) return previous;
      const prepared = await this.sources.prepare(input.scope);
      return project.coordinator.plan(command, async (view) => {
        await assertAdmitted?.();
        if (
          !(await this.sources.unchanged(view, project.owned, input, new ProjectGitSnapshots(project.owned), prepared))
        )
          throw new KnowledgeWriteConflict("sourceChanged");
        const path = projectKnowledgeFile(record.id),
          previous = await capturePreviousKnowledge(view, record.id);
        if (
          (previous ? (previousRecord(previous)?.version ?? null) : null) !== record.previousVersion ||
          (input.target.previous && (!previous || previousState(previous) !== input.target.previous.state)) ||
          (previous &&
            previousRequiresReview(previous) &&
            (!input.target.previous || record.approval?.mode === "automatic"))
        )
          throw new KnowledgeWriteConflict("targetChanged");
        return {
          changes: [
            { path, content: stableJson(record) + "\n" },
            { path: projectKnowledgeMarkdown(record.id), content: knowledgeMarkdown(record) },
          ],
        };
      });
    });
    return { id: record.id, version: record.version, commit: result.commit };
  }
}
