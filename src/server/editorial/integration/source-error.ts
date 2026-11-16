import { DocumentError } from "../../documents/errors.js";
import { EditorialError } from "../errors.js";

export function editorialSourceError(error: unknown): never {
  if (error instanceof DocumentError)
    throw new EditorialError(
      error.status === 404
        ? "notFound"
        : error.code === "workingCopyChanged"
          ? "workingCopyChanged"
          : error.code === "conflict"
            ? "staleSource"
            : error.code === "invalidRichBody"
              ? "invalidPatch"
              : "unavailable",
      error.status === 404 ? 404 : error.status === 409 ? 409 : 503,
    );
  throw error;
}
