import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import { createHash } from "node:crypto";
import { SEARCH_LIMITS, SearchError } from "../../../shared/search/contracts.js";
import { searchRecord, searchText } from "../../../shared/search/validation.js";
import { readSourceZip } from "../../packages/zip/read.js";
import { GitHubPackageSources } from "../../packages/github/source.js";
import { BoundedSourceHttp } from "../../packages/source-http.js";
import type { AnalyzerStore } from "../analyzers/store.js";
const limits = {
  archiveBytes: 2 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024,
  fileBytes: SEARCH_LIMITS.analyzerBytes,
  files: 64,
  entries: 128,
};
function packages(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value) && "analyzers" in value) {
    const p = searchRecord(value, ["schema", "analyzers"]);
    if (p.schema !== 1 || !Array.isArray(p.analyzers)) throw new SearchError("invalidInput");
    return p.analyzers;
  }
  return value;
}
export async function reviewAnalyzers(
  store: MetadataStore<AnalyzerStore>,
  owner: string,
  input: unknown,
  signal: AbortSignal,
) {
  const p = searchRecord(input, ["kind", "name", "content", "repository", "ref", "root"]);
  if (p.kind === "json")
    return store.review(owner, packages(p.content), { kind: "json-upload", name: searchText(p.name, 120) });
  if (p.kind === "zip") {
    if (typeof p.content !== "string" || p.content.length > 3 * 1024 * 1024) throw new SearchError("limit");
    const bytes = Buffer.from(p.content, "base64");
    if (bytes.toString("base64") !== p.content) throw new SearchError("invalidInput");
    const tree = await readSourceZip(bytes, limits, signal),
      all = tree.files
        .filter((f) => f.path.endsWith(".json"))
        .flatMap((f) => {
          const value = packages(JSON.parse(tree.text(f.path)));
          return Array.isArray(value) ? value : [value];
        });
    return store.review(owner, all, {
      kind: "zip-upload",
      name: searchText(p.name, 120),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (p.kind === "github") {
    const capture = await new GitHubPackageSources(new BoundedSourceHttp(), undefined, limits).capture(
      { repository: p.repository, ...(p.ref ? { ref: p.ref } : {}), root: p.root || "" },
      ["analyzers.json"],
      signal,
    );
    return store.review(owner, packages(JSON.parse(capture.tree.text("analyzers.json"))), {
      ...capture.descriptor.origin,
    });
  }
  throw new SearchError("invalidInput");
}
