import { HarnessError } from "../../../shared/harness/contracts.js";
import { DocumentError } from "../../documents/errors.js";
import { KnowledgeTaskError } from "../../knowledge/tasks/contracts.js";
import { KnowledgeError } from "../../../shared/knowledge/contracts.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { CliError } from "../../../shared/cli/contracts.js";

/** Browser registration and registered commands expose the same stable content-authorization errors. */
export function cliContentError(error: unknown): unknown {
  if (error instanceof CliError) return error;
  if (error instanceof SearchError && ["configuration", "notReady", "indexChanged"].includes(error.code))
    return new CliError(error.code as "configuration" | "notReady" | "indexChanged", error.status);
  if (
    error instanceof DocumentError ||
    error instanceof HarnessError ||
    error instanceof KnowledgeTaskError ||
    error instanceof KnowledgeError ||
    error instanceof SearchError
  )
    return new CliError(
      error.status === 403
        ? "forbidden"
        : error.status === 404
          ? "notFound"
          : error.status === 409
            ? "conflict"
            : error.status === 429
              ? "limit"
              : error.status === 400
                ? "invalidInput"
                : "unavailable",
      error.status,
    );
  return error;
}
