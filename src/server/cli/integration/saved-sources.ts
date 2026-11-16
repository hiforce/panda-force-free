import { CliError, cliId } from "../../../shared/cli/contracts.js";
import { selectedSourceKinds } from "../../../shared/content-sources/selection.js";
import { savedSourceSummary } from "../../../shared/content-sources/catalog.js";
import { SavedSourcePageError, savedSourcePage } from "../../content-sources/catalog.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";

/** Native text uses the same authorized original reader as search, without starting creation or inference services. */
export async function executeSavedSourceCommand(
  originals: FileOriginalQueries,
  command: "sources.list" | "sources.read",
  project: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const kinds = selectedSourceKinds(args.contentKinds);
  if (!kinds) throw new CliError("invalidInput");
  if (command === "sources.read") {
    if (
      args.sourceVersion !== undefined &&
      (typeof args.sourceVersion !== "string" ||
        !args.sourceVersion.length ||
        args.sourceVersion.length > 160 ||
        /[\p{Cc}\p{Cf}]/u.test(args.sourceVersion))
    )
      throw new CliError("invalidInput");
    const values = await originals.current(project, [cliId(args.id)], kinds, signal),
      row = values[0];
    if (!row) throw new CliError("notFound", 404);
    if (args.sourceVersion !== undefined && row.metadata.version !== args.sourceVersion)
      throw new CliError("conflict", 409);
    signal.throwIfAborted();
    return { source: { ...savedSourceSummary(project, row.metadata), text: row.text, sections: row.sections } };
  }
  try {
    const page = await savedSourcePage(originals, project, args);
    signal.throwIfAborted();
    return page;
  } catch (error) {
    if (error instanceof SavedSourcePageError)
      throw new CliError(
        error.code === "changed" ? "indexChanged" : "invalidInput",
        error.code === "changed" ? 409 : 400,
      );
    throw error;
  }
}
