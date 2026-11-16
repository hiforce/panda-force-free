import { mapMetadata, metadataFailure } from "../../../shared/async-value.js";
import { errorStatus } from "../../../shared/errors.js";
import { DocumentError } from "../errors.js";

/** Keep synchronous SQLite callers synchronous while native database adapters remain awaitable. */
export function documentProjectGuards<P>(
  read: (id: string) => P | Promise<P>,
  files: (id: string) => boolean | Promise<boolean>,
) {
  const requireProject = (id: string) =>
    metadataFailure(
      () => read(id),
      (error) => {
        if (errorStatus(error) === 404) throw new DocumentError("notFound", 404);
        throw error;
      },
    );
  const requireStorage = (id: string, expected: boolean) =>
    mapMetadata(requireProject(id), (project) =>
      mapMetadata(files(id), (usesFiles) => {
        if (usesFiles !== expected) throw new DocumentError("notFound", 404);
        return project;
      }),
    );
  return {
    requireProject,
    requireFileProject: (id: string) => requireStorage(id, true),
    requireLegacyProject: (id: string) => requireStorage(id, false),
  };
}
