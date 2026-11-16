import { documentApi } from "../api.js";
import { legacyDocumentSpaces } from "../space-api.js";
import { documentPlacementsApi } from "./api.js";
import { filePublicationApi } from "./file-api.js";
import type { DocumentPublicationScope, PublicationConfigurationApi } from "./port.js";

export function publicationConfigurationApi(
  scope: DocumentPublicationScope | undefined,
  identity: string,
): PublicationConfigurationApi {
  if (scope?.storage === "files") return filePublicationApi(scope.projectId, identity);
  return {
    sources: documentApi,
    spaces: legacyDocumentSpaces,
    placements: documentPlacementsApi,
  };
}
