import { metadataFailure, type MetadataStore } from "../../../../shared/async-value.js";
import type { DocumentEngine } from "../../../../shared/documents/contracts.js";
import { ThemeSelectionError, type SiteThemeCatalog } from "../../../../shared/presentation/themes.js";
import { SiteProfileError } from "../../../../shared/sites/config.js";
import { siteSourceProfile } from "../../../../shared/sites/profile.js";
import { DocumentError } from "../../errors.js";
import { expectedVersion, spaceInput, text } from "../../validation.js";
import { documentOperationUuid, editorInput } from "../commands.js";
import { documentIdentity } from "../projects.js";

export function configuredTheme(catalog: MetadataStore<SiteThemeCatalog>, reference: string, engine: DocumentEngine) {
  return metadataFailure(
    () => catalog.validate(reference, engine),
    (error) => {
      if (error instanceof ThemeSelectionError) throw new DocumentError(error.code);
      throw error;
    },
  );
}
export function createSpaceCommand(value: unknown) {
  const input = editorInput(value, [
      "operationId",
      "projectId",
      "code",
      "name",
      "engine",
      "sourceMode",
      "sourceRoot",
      "locale",
      "theme",
    ]),
    operationId = documentOperationUuid(input.operationId),
    space = spaceInput(input);
  documentIdentity(space.projectId);
  if (space.sourceMode === "managed" && input.sourceRoot !== undefined) throw new DocumentError("invalidInput");
  return { operationId, input: space };
}
export function spaceEdits(value: unknown) {
  const input = editorInput(value, ["operationId", "version", "name", "theme", "profile"]),
    operationId = documentOperationUuid(input.operationId),
    version = expectedVersion(input.version),
    name = input.name === undefined ? undefined : text(input.name, 100),
    theme = input.theme === undefined ? undefined : text(input.theme, 100);
  if (name === undefined && theme === undefined && input.profile === undefined) throw new DocumentError("invalidInput");
  try {
    const profile =
      input.profile === undefined ? undefined : input.profile === null ? null : siteSourceProfile(input.profile);
    return { operationId, version, name, theme, profile };
  } catch (error) {
    if (error instanceof SiteProfileError) throw new DocumentError("invalidSourceConfiguration");
    throw error;
  }
}
