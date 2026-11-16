import { isRecord } from "../../../../shared/records.js";
import { stableJson } from "../../../../shared/stable-json.js";
import { DocumentError } from "../../errors.js";
import { documentPath, expectedVersion, localeText } from "../../validation.js";
import { documentOperationUuid, editorInput } from "../commands.js";
import { documentIdentity } from "../projects.js";

export function filePlacementCommand(kind: "create" | "update" | "remove", value: unknown) {
  const input = editorInput(
    value,
    kind === "create"
      ? ["operationId", "id", "documentId", "spaceId", "path", "locale", "revisionId", "metadata", "spaceVersion"]
      : kind === "update"
        ? ["operationId", "version", "spaceVersion", "path", "locale", "revisionId", "metadata"]
        : ["operationId", "version", "spaceVersion"],
  );
  const base = {
    kind,
    operationId: documentOperationUuid(input.operationId),
    spaceVersion: expectedVersion(input.spaceVersion),
    version: kind === "create" ? null : expectedVersion(input.version),
  };
  if (kind === "remove") return { ...base, fields: null, ids: null };
  const metadata = input.metadata ?? {};
  if (!isRecord(metadata) || Buffer.byteLength(stableJson(metadata)) > 65536)
    throw new DocumentError("invalidPlacementMetadata");
  return {
    ...base,
    fields: {
      path: documentPath(input.path).normalize("NFC"),
      locale: localeText(input.locale),
      revisionId:
        input.revisionId === null || input.revisionId === undefined ? null : documentIdentity(input.revisionId),
      metadata: structuredClone(metadata),
    },
    ids:
      kind === "create"
        ? {
            id: documentOperationUuid(input.id),
            documentId: documentIdentity(input.documentId),
            spaceId: documentIdentity(input.spaceId),
          }
        : null,
  };
}
