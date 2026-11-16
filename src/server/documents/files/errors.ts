import { ProjectContentError } from "../../project-content/errors.js";
import { DocumentError } from "../errors.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";

/** Storage diagnostics stay server-side; transport consumers receive the established document error contract. */
export async function documentFileOperation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ProjectContentError)) throw error;
    if (error.code === "notFound") throw new DocumentError("notFound", 404);
    if (error.code === "tooLarge") throw new DocumentError("tooLarge", 413);
    if (error.code === "conflict") throw new DocumentError("conflict", 409);
    if (error.code === "workingCopyChanged") throw new DocumentError("workingCopyChanged", 409);
    if (error.code !== "unavailable") reportDiagnostic("document-files", error);
    throw new DocumentError("unavailable", 503);
  }
}
