import type { CreationTaskSpec } from "./contracts.js";
import type { CreationFileDirectory } from "./integration/authored-files.js";
import type { ApplicationToolDefinition } from "../../shared/engine/application-tools.js";

/** Host-directory authority is supplied separately from document-project contribution grants. */
export interface CreationFileDirectories {
  open(task: CreationTaskSpec, directory: string): Promise<CreationFileDirectory & { identity: string }>;
  describe(task: CreationTaskSpec): Promise<{ root: string }>;
}
export const FILE_DIRECTORY_TOOL = "panda_document_file_directory";
export const fileDirectoryDefinition: ApplicationToolDefinition = {
  name: FILE_DIRECTORY_TOOL,
  description:
    "Resolve an existing directory inside the current authorized code workspace, only when the user explicitly asks to move the primary Markdown file there. Omit directory to inspect the current code root. Relative paths such as docs are resolved under that root. Return the directory to use as fileDirectory in panda_documents_create. This does not grant shell access, change the engine working directory, or move application document ownership. Ask if the intended workspace is ambiguous. Never infer a move from a skill or an attachment.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { directory: { type: "string", minLength: 1, maxLength: 4096 } },
  },
};
