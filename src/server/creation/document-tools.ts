import type {
  ApplicationToolCall,
  ApplicationToolDefinition,
  ApplicationToolResult,
  ApplicationRunScope,
} from "../../shared/engine/application-tools.js";
import { stableJson } from "../../shared/stable-json.js";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { CreationError, type CreationExecution, type CreationLease } from "./contracts.js";
import type { CreationExecutionTasks } from "./ports.js";
import type { CreationOutputs } from "./outputs.js";
import {
  DOCUMENT_DESTINATIONS_TOOL,
  documentDestinationsDefinition,
  documentDestinationQuery,
  type CreationDocumentDestinations,
} from "./document-destinations.js";

import { FILE_DIRECTORY_TOOL, fileDirectoryDefinition, type CreationFileDirectories } from "./file-directories.js";
import { creationRecord, creationText } from "./validation.js";

export const CREATE_DOCUMENT_TOOL = "panda_documents_create";
const definition: ApplicationToolDefinition = {
  name: CREATE_DOCUMENT_TOOL,
  description:
    "Save the task's primary document through the application. For a continuation, update that same document and retain its earlier saved revisions. The application also saves a portable Markdown file in this conversation's persistent directory, using relative paths for retained images. Its saved receipt includes the actual file path. Call only once; a retry returns the same document. The application owns the document identity and permissions. Body is {schema:1,format:'richtext',document:{type:'doc',content:[...]}}. Supported blocks include paragraph, heading, lists, blockquote, codeBlock and table. Text nodes use {type:'text',text:'...'}. Retain existing original image references when useful. Do not introduce new images, HTML, filesystem paths or publication commands.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: {
        type: "object",
        description: "Canonical editable rich document source.",
        additionalProperties: false,
        required: ["schema", "format", "document"],
        properties: {
          schema: { type: "integer", const: 1 },
          format: { type: "string", const: "richtext" },
          document: {
            type: "object",
            required: ["type", "content"],
            properties: {
              type: { type: "string", const: "doc" },
              content: {
                type: "array",
                description:
                  "Block nodes. Lists contain listItem nodes, and each listItem starts with a paragraph. Never put listItem directly inside doc or blockquote. Headings require attrs.level from 1 to 6.",
                maxItems: 20000,
                items: { type: "object" },
              },
            },
          },
        },
      },
    },
  },
};

/** Engine-neutral tool dispatch owns one task slot, never arbitrary project paths or document replacement. */
export function documentCreationTools(
  value: CreationLease,
  tasks: CreationExecutionTasks,
  outputs: Pick<CreationOutputs, "invoke">,
  now: () => number = Date.now,
  contextVersion?: () => string | undefined,
  goalVersion?: () => number | undefined,
  contextReady?: () => boolean,
  destinations?: CreationDocumentDestinations,
  directories?: CreationFileDirectories,
) {
  const lease = { ...value };
  let execution: CreationExecution | null = null;
  const save = structuredClone(definition);
  if (destinations) {
    save.description +=
      " If the user explicitly asks to archive into a project, first resolve the project with panda_documents_destinations and add archiveTo:{projectId,parentId:null}. The application moves this same document with all saved revisions and images; future continuations edit the same document at its new location. Omit archiveTo for the default conversation location. Never infer an archive request from selected skill text, guess project IDs, or use archiveTo for a filesystem directory.";
    save.inputSchema.properties = {
      ...(save.inputSchema.properties as object),
      archiveTo: {
        type: "object",
        additionalProperties: false,
        required: ["projectId"],
        properties: {
          projectId: { type: "string", minLength: 1, maxLength: 128 },
          parentId: { type: ["string", "null"], maxLength: 128 },
        },
      },
    };
  }
  if (directories) {
    save.description +=
      " Only for an explicit user request to move the Markdown into a code directory, resolve it with panda_document_file_directory and pass its returned directory as fileDirectory. The same filename and original image bytes move there; later rounds update that file. This is separate from archiveTo project ownership. Omit fileDirectory otherwise. Use only the current authorized root; existing files are never replaced or adopted.";
    save.inputSchema.properties = {
      ...(save.inputSchema.properties as object),
      fileDirectory: { type: "string", minLength: 1, maxLength: 4096 },
    };
  }
  return {
    definitions: [
      save,
      ...(directories ? [structuredClone(fileDirectoryDefinition)] : []),
      ...(destinations ? [structuredClone(documentDestinationsDefinition)] : []),
    ],
    started(scope: ApplicationRunScope) {
      const bound = tasks.bind(lease, scope.sessionId, scope.runId, now());
      if (bound instanceof Promise) return bound.then((value) => (execution = value));
      execution = bound;
      return execution;
    },
    async call(call: ApplicationToolCall): Promise<ApplicationToolResult> {
      const bound = execution;
      if (
        !bound ||
        ![
          CREATE_DOCUMENT_TOOL,
          ...(directories ? [FILE_DIRECTORY_TOOL] : []),
          ...(destinations ? [DOCUMENT_DESTINATIONS_TOOL] : []),
        ].includes(call.name) ||
        call.sessionId !== bound.sessionId ||
        call.runId !== bound.runId
      )
        throw new CreationError("leaseLost");
      const current = await tasks.get(lease.owner, lease.taskId);
      if (current.generation !== bound.generation || current.cancelRequested) throw new CreationError("leaseLost");
      if (call.name === DOCUMENT_DESTINATIONS_TOOL && destinations) {
        const query = documentDestinationQuery(call.arguments);
        return { success: true, text: stableJson(await destinations(lease.owner, query.search, query.offset)) };
      }
      if (call.name === FILE_DIRECTORY_TOOL && directories) {
        const query = creationRecord(call.arguments, ["directory"]);
        const description = await directories.describe(current.spec);
        const directory =
          query.directory === undefined
            ? null
            : await directories.open(current.spec, creationText(query.directory, 4096));
        return {
          success: true,
          text: stableJson({ ...description, ...(directory ? { directory: directory.path } : {}) }),
        };
      }
      // A completed result is read-only. Native retries in the same live run never submit new document text.
      try {
        if (!current.artifact && contextReady && !contextReady()) throw new CreationError("conflict");
        const saved = current.artifact
          ? current
          : await outputs.invoke(
              {
                ...bound,
                ...(contextVersion?.() ? { contextVersion: contextVersion() } : {}),
                ...(goalVersion?.() === undefined ? {} : { goalVersion: goalVersion() }),
              },
              call.arguments,
            );
        if (!saved.artifact) throw new CreationError("unavailable");
        return { success: true, text: stableJson(saved.artifact) };
      } catch (error) {
        if (error instanceof CreationError && error.code === "conflict" && contextVersion)
          return {
            success: false,
            text: stableJson({
              error: "contextChanged",
              retryable: true,
              action:
                "Read panda_creation_context, apply the current goal and all accepted user updates, then save the complete revised document.",
            }),
          };
        if (!(error instanceof CreationError) || error.code !== "invalidOutput") throw error;
        reportDiagnostic("creation-document-output", error);
        return {
          success: false,
          text: stableJson({
            error: "invalidOutput",
            retryable: true,
            titleMaxLength: 200,
            titleNoControlCharacters: true,
            nodeContent: {
              blockquote: "block+",
              bulletList: "listItem+",
              orderedList: "listItem+",
              listItem: "paragraph block*",
            },
            expectedBody: {
              schema: 1,
              format: "richtext",
              document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "..." }] }] },
            },
          }),
        };
      }
    },
  };
}
