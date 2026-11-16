import { selectedSourceKinds } from "../../shared/content-sources/selection.js";
import { savedSourceSummary, type SavedSourcePage } from "../../shared/content-sources/catalog.js";
import type { FileOriginalQueries } from "./reader.js";

export class SavedSourcePageError extends Error {
  constructor(readonly code: "invalidInput" | "changed") {
    super(code);
  }
}

/** Browser and registered clients page the same authorized metadata, without parsing originals or retaining authority. */
export async function savedSourcePage(
  originals: Pick<FileOriginalQueries, "metadata">,
  project: string,
  input: { contentKinds?: unknown; search?: unknown; offset?: unknown; head?: unknown },
): Promise<SavedSourcePage> {
  const kinds = selectedSourceKinds(input.contentKinds),
    search = input.search === undefined ? "" : input.search,
    offset = input.offset === undefined ? 0 : input.offset,
    head = input.head;
  if (
    !kinds ||
    typeof search !== "string" ||
    search.length > 200 ||
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) > 10000 ||
    (head !== undefined && (typeof head !== "string" || (head !== "empty" && !/^[a-f0-9]{64}$/.test(head))))
  )
    throw new SavedSourcePageError("invalidInput");
  const query = search.normalize("NFC").toLowerCase(),
    start = Number(offset),
    result = await originals.metadata(project, kinds);
  if (head !== undefined && result.head !== head) throw new SavedSourcePageError("changed");
  const rows = result.entries.filter(
    (row) => !query || (row.title + "\n" + row.path).normalize("NFC").toLowerCase().includes(query),
  );
  return {
    head: result.head,
    sources: rows.slice(start, start + 100).map((row) => savedSourceSummary(project, row)),
    total: rows.length,
    nextOffset: start + 100 < rows.length ? start + 100 : null,
  };
}
