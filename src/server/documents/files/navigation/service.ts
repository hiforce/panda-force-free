import type { DocumentTreeMutation } from "../../../../shared/documents/navigation.js";
import { stableJson } from "../../../../shared/stable-json.js";
import type { ProjectContentProject } from "../../../project-content/project.js";
import { ProjectContentPlan } from "../../../project-content/plan-view.js";
import type { ProjectNavigationOperation } from "../../../project-content/navigation-operation-file.js";
import type { DocumentNavigationPort } from "../../navigation/port.js";
import { DocumentError } from "../../errors.js";
import { documentAuthor } from "../commands.js";
import type { DocumentFileProjects } from "../projects.js";
import { fileTreeCommand, type FileTreeCommand } from "./commands.js";
import { readFileTree } from "./read.js";
import { FileTreeQueries } from "./queries.js";
import { prepareTreeLibrary } from "./source-plan.js";
import { planTreeAction } from "./topology-plan.js";
import { navigationRequest } from "../../navigation/validation.js";
import type { DocumentCreationSource } from "../../creation-port.js";
import type { FileDocumentCreationContent } from "../creation-content.js";

function receipt(record: ProjectNavigationOperation | null, command: FileTreeCommand) {
  if (!record) return null;
  if (record.owner !== command.owner) throw new DocumentError("notFound", 404);
  if (record.request !== command.request) throw new DocumentError("conflict", 409);
  if (record.result === null) throw new DocumentError("navigationConflict", 409);
  return record.result;
}

/** One application coordinates manual and agent commands; each source/tree/receipt change shares a single project commit. */
export class FileDocumentNavigation implements DocumentNavigationPort {
  private readonly queries: FileTreeQueries;
  constructor(
    private readonly projects: DocumentFileProjects,
    private readonly content?: FileDocumentCreationContent,
  ) {
    this.queries = new FileTreeQueries(projects);
  }
  tree(projectId: string) {
    return this.queries.tree(projectId);
  }
  trashPage(projectId: string, cursor?: string) {
    return this.queries.trashPage(projectId, cursor);
  }
  create(actor: string, input: unknown) {
    return this.execute(fileTreeCommand("create", actor, input));
  }
  createFromSource(actor: string, input: unknown, producer: DocumentCreationSource) {
    if (!this.content) throw new DocumentError("unavailable", 503);
    const command = fileTreeCommand("create", actor, input),
      source = { identity: producer.identity, prepare: producer.prepare.bind(producer) };
    return this.execute(
      { ...command, request: navigationRequest({ base: command.request, source: source.identity }) },
      source,
    );
  }
  /** Task-owned creation appends to a logical parent under the project lease, without pinning a stale UI tree version. */
  appendFromSource(actor: string, input: unknown, producer: DocumentCreationSource) {
    if (!this.content) throw new DocumentError("unavailable", 503);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.hasOwn(input, "treeVersion"))
      throw new DocumentError("invalidInput");
    const { minimumTreeVersion = 0, ...fields } = input as Record<string, unknown>;
    if (!Number.isSafeInteger(minimumTreeVersion) || Number(minimumTreeVersion) < 0)
      throw new DocumentError("invalidInput");
    const command = fileTreeCommand("create", actor, { ...fields, treeVersion: 0 }),
      source = { identity: producer.identity, prepare: producer.prepare.bind(producer) };
    return this.execute(
      {
        ...command,
        request: navigationRequest({ base: command.request, source: source.identity, append: minimumTreeVersion }),
      },
      source,
      Number(minimumTreeVersion),
    );
  }
  move(actor: string, input: unknown) {
    return this.execute(fileTreeCommand("move", actor, input));
  }
  rename(actor: string, input: unknown) {
    return this.execute(fileTreeCommand("rename", actor, input));
  }
  trash(actor: string, input: unknown) {
    return this.execute(fileTreeCommand("trash", actor, input));
  }
  restore(actor: string, input: unknown) {
    return this.execute(fileTreeCommand("restore", actor, input));
  }

  private async execute(
    command: FileTreeCommand,
    source?: DocumentCreationSource,
    appendMinimum?: number,
  ): Promise<DocumentTreeMutation> {
    const mutate = async (project: ProjectContentProject) =>
      project.coordinator.plan(
        {
          operationId: command.id,
          author: documentAuthor(command.owner),
          message: "Apply project document tree operation",
          intent: stableJson({
            schema: 1,
            kind: "document-tree",
            projectId: command.projectId,
            owner: command.owner,
            request: command.request,
          }),
        },
        async (view) => {
          if (receipt(await project.navigationOperations.lookup(view, command.id), command)) return { changes: [] };
          const plan = new ProjectContentPlan(view);
          let snapshot = await readFileTree(plan, command.projectId);
          const current =
            appendMinimum !== undefined && command.kind === "create"
              ? { ...command, version: snapshot.tree.version }
              : command;
          if (appendMinimum !== undefined && snapshot.tree.version < appendMinimum)
            throw new DocumentError("navigationConflict", 409);
          if (snapshot.tree.version !== current.version) throw new DocumentError("navigationConflict", 409);
          if (!snapshot.space && command.kind === "create") {
            if (command.parentId !== null) throw new DocumentError("notFound", 404);
            await prepareTreeLibrary(project, plan, command);
            snapshot = await readFileTree(plan, command.projectId);
          }
          const message = await planTreeAction(
            project,
            plan,
            current,
            snapshot,
            source
              ? (documentId) => source.prepare().then((seed) => this.content!.prepare(project, documentId, seed))
              : undefined,
          );
          return { changes: plan.changes(), ...(message === undefined ? {} : { message }) };
        },
      );
    if (command.kind === "create" && command.version === 0 && command.parentId === null)
      await this.projects.initialize(command.projectId, mutate);
    else await this.projects.write(command.projectId, mutate);
    return this.projects.view(command.projectId, async (project, view) => {
      const operation = receipt(await project.navigationOperations.lookup(view, command.id), command);
      if (!operation) throw new DocumentError("unavailable", 503);
      return { tree: (await readFileTree(view, command.projectId)).tree, operation };
    });
  }
}
