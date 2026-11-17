import type { ApplicationToolDefinition } from "../../shared/engine/application-tools.js";
import { creationInteger, creationRecord } from "./validation.js";
import { CreationError } from "./contracts.js";

export type CreationDocumentDestinations = (
  owner: string,
  search: string,
  offset: number,
) => Promise<{
  projects: { id: string; name: string }[];
  personalProjectId: string;
  nextOffset: number | null;
}>;
export const DOCUMENT_DESTINATIONS_TOOL = "panda_documents_destinations";
export const documentDestinationsDefinition: ApplicationToolDefinition = {
  name: DOCUMENT_DESTINATIONS_TOOL,
  description:
    "Find projects this authenticated user can contribute to, only when the user asks to archive the primary document into a project. Search by the user's project name. Return project IDs and names in pages; use nextOffset to continue. Ask the user when the intended project is ambiguous. Project membership is rechecked on save. This read does not move or copy any document.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      search: { type: "string", maxLength: 200 },
      offset: { type: "integer", minimum: 0, maximum: 100000 },
    },
  },
};
export function documentDestinationQuery(value: unknown) {
  const v = creationRecord(value, ["search", "offset"]),
    search = v.search ?? "",
    offset = creationInteger(v.offset ?? 0);
  if (typeof search !== "string" || search.length > 200 || /[\p{Cc}]/u.test(search) || offset > 100000)
    throw new CreationError("invalidInput");
  return { search, offset };
}
