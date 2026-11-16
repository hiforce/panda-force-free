import type { SavedSourceMetadata, SavedSourceText } from "../../../shared/content-sources/contracts.js";
import type { SearchDocument, SearchReadScope } from "../../../shared/search/contracts.js";
import { SearchError, SEARCH_LIMITS } from "../../../shared/search/contracts.js";
import { searchContentKinds } from "../../../shared/search/validation.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import type { SearchSource } from "../ports.js";

function projection(metadata: SavedSourceMetadata): Omit<SearchDocument, "text"> {
  return {
    id: metadata.id,
    version: metadata.version,
    title: metadata.title,
    locale: metadata.locale,
    path: metadata.path,
    updatedAt: metadata.updatedAt,
    ancestors: metadata.ancestors,
    ...(metadata.binding.kind === "document" ? {} : { kind: metadata.binding.kind }),
  };
}
function textProjection(value: SavedSourceText): SearchDocument {
  if (Buffer.byteLength(value.text) > SEARCH_LIMITS.documentBytes) throw new SearchError("limit", 409);
  return { ...projection(value.metadata), text: value.text };
}

/** Historical document-only reads retain their original head and text projection. Native originals require explicit kinds. */
export function originalSearchSource(options: {
  documents: SearchSource;
  originals(scope: SearchReadScope): Promise<FileOriginalQueries>;
}): SearchSource {
  const selection = (scope: SearchReadScope) => ({
    owner: scope.owner,
    project: scope.project,
    source: scope.source,
    contentKinds: searchContentKinds(scope.contentKinds),
  });
  const documentOnly = (scope: SearchReadScope) =>
    scope.contentKinds.length === 1 && scope.contentKinds[0] === "document";
  return {
    authorize: (scope) => options.documents.authorize(scope),
    async head(input) {
      const scope = selection(input);
      if (documentOnly(scope)) return options.documents.head(scope);
      await options.documents.authorize(scope);
      const value = await (await options.originals(scope)).metadata(scope.project, scope.contentKinds);
      await options.documents.authorize(scope);
      return value.head;
    },
    async metadata(input) {
      const scope = selection(input);
      await options.documents.authorize(scope);
      const value = await (await options.originals(scope)).metadata(scope.project, scope.contentKinds);
      const commit = documentOnly(scope) ? await options.documents.head(scope) : value.head;
      await options.documents.authorize(scope);
      return { commit, documents: value.entries.map(projection) };
    },
    async snapshot(input, signal) {
      const scope = selection(input);
      if (documentOnly(scope)) return options.documents.snapshot(scope, signal);
      await options.documents.authorize(scope);
      const value = await (await options.originals(scope)).snapshot(scope.project, scope.contentKinds, signal);
      await options.documents.authorize(scope);
      return { commit: value.head, documents: value.sources.map(textProjection) };
    },
    async current(input, ids, signal) {
      const scope = selection(input),
        selectedIds = [...ids];
      if (documentOnly(scope)) return options.documents.current(scope, selectedIds, signal);
      await options.documents.authorize(scope);
      const value = await (
        await options.originals(scope)
      ).current(scope.project, selectedIds, scope.contentKinds, signal);
      await options.documents.authorize(scope);
      return value.map(textProjection);
    },
  };
}
