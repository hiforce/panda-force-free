import type { FileDocumentNavigation } from "../../documents/files/navigation/service.js";
import type { FileDocumentQueries } from "../../documents/files/queries.js";
import type { FileDocumentSpaces } from "../../documents/files/spaces/service.js";
import type { KnowledgeTasks } from "../../knowledge/tasks/service.js";
import type { KnowledgeRecords } from "../../knowledge/catalog/read.js";
import { CliError, cliId } from "../../../shared/cli/contracts.js";
import { cliContentError } from "./errors.js";
import type { CliContentCommands } from "../commands.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import { executeSavedSourceCommand } from "./saved-sources.js";
type Knowledge = Pick<
  KnowledgeTasks,
  "list" | "history" | "status" | "detail" | "previous" | "submit" | "answer" | "edit" | "approve" | "cancel" | "retry"
>;
export function cliContentCommands(options: {
  originals?(owner: string, project: string): Promise<FileOriginalQueries>;
  documents(
    owner: string,
    project: string,
  ): Promise<{
    queries: Pick<FileDocumentQueries, "list" | "detail">;
    spaces: Pick<FileDocumentSpaces, "list">;
    navigation: Pick<FileDocumentNavigation, "tree">;
  }>;
  authorize(owner: string, project: string): Promise<void>;
  knowledge: Knowledge;
  records: Pick<KnowledgeRecords, "detail">;
  search(owner: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  searchStatus(owner: string, project: string): Promise<unknown>;
}): CliContentCommands {
  return {
    async execute(owner, id, args, signal) {
      try {
        const project = cliId(args.project);
        await options.authorize(owner, project);
        signal.throwIfAborted();
        if (id === "sources.list" || id === "sources.read") {
          if (!options.originals) throw new CliError("unavailable", 503);
          return await executeSavedSourceCommand(await options.originals(owner, project), id, project, args, signal);
        }
        if (id === "spaces.list")
          return {
            spaces: (await (await options.documents(owner, project)).spaces.list(project)).map(
              ({ id, name, version }) => ({ id, name, version }),
            ),
          };
        if (id === "documents.list") {
          const documents = await options.documents(owner, project);
          if (args.search !== undefined && (typeof args.search !== "string" || args.search.length > 200))
            throw new CliError("invalidInput");
          if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))
            throw new CliError("invalidInput");
          if (args.space === undefined) {
            const tree = await documents.navigation.tree(project),
              search = String(args.search ?? "")
                .normalize("NFC")
                .toLowerCase(),
              offset = Number(args.offset ?? 0);
            const rows = tree.nodes
              .map((node) => node.document)
              .filter(
                (doc) => !search || (doc.title + "\n" + doc.path).normalize("NFC").toLowerCase().includes(search),
              );
            return {
              documents: rows.slice(offset, offset + 100),
              total: rows.length,
              nextOffset: offset + 100 < rows.length ? offset + 100 : null,
              treeVersion: tree.version,
            };
          }
          return await documents.queries.list(
            project,
            cliId(args.space),
            args.search as string | undefined,
            args.offset as number | undefined,
          );
        }
        if (id === "documents.read")
          return await (await options.documents(owner, project)).queries.detail(project, cliId(args.id));
        // Await inside this error boundary so rejected service promises retain their public error classification.
        if (id === "search.query") return await options.search(owner, args, signal);
        if (id === "search.status") return await options.searchStatus(owner, project);
        if (id === "knowledge.records.read") return await options.records.detail(owner, { project, id: args.id });
        if (id === "knowledge.list") {
          if (args.cursor !== undefined && typeof args.cursor !== "string") throw new CliError("invalidInput");
          return await options.knowledge.history(owner, project, args.cursor as string | undefined);
        }
        if (id === "knowledge.create") return { task: await options.knowledge.submit(owner, args) };
        const taskId = cliId(args.id),
          task = await options.knowledge.status(owner, taskId);
        if (task.project !== project) throw new CliError("notFound", 404);
        if (id === "knowledge.status") return { task };
        if (id === "knowledge.read") return await options.knowledge.detail(owner, taskId);
        if (id === "knowledge.previous")
          return await options.knowledge.previous(owner, taskId, args.offset as number | undefined);
        const updated =
          id === "knowledge.answer"
            ? await options.knowledge.answer(owner, taskId, { answers: args.answers })
            : id === "knowledge.edit"
              ? await options.knowledge.edit(owner, taskId, { revision: args.revision, draft: args.draft })
              : id === "knowledge.approve"
                ? await options.knowledge.approve(owner, taskId, {
                    revision: args.revision,
                    ...(args.previousState === undefined ? {} : { previousState: args.previousState }),
                  })
                : id === "knowledge.cancel"
                  ? await options.knowledge.cancel(owner, taskId)
                  : id === "knowledge.retry"
                    ? await options.knowledge.retry(owner, taskId)
                    : null;
        if (!updated) throw new CliError("notFound", 404);
        return { task: updated };
      } catch (error) {
        throw cliContentError(error);
      }
    },
  };
}
