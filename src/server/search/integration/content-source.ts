import type { SearchDocument, SearchScope } from "../../../shared/search/contracts.js";
import { SEARCH_LIMITS, SearchError } from "../../../shared/search/contracts.js";
import type { DocumentDetail } from "../../../shared/documents/contracts.js";
import type { RichTextNode } from "../../../shared/documents/rich-body.js";
import type { FileDocumentQueries } from "../../documents/files/queries.js";
import type { SearchSource } from "../ports.js";
interface SavedQueries {
  searchHead: FileDocumentQueries["searchHead"];
  savedBatch: FileDocumentQueries["savedBatch"];
  savedSnapshot: FileDocumentQueries["savedSnapshot"];
}
function plain(node: RichTextNode): string {
  if (node.text) return node.text;
  if (node.type === "image") return typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
  return (node.content || [])
    .map(plain)
    .join(["paragraph", "heading", "codeBlock", "text"].includes(node.type) ? "" : "\n");
}
function projection(value: DocumentDetail & { ancestors: string[] }): SearchDocument {
  const d = value.document,
    r = value.revision,
    text = r.body
      ? plain(r.body.document)
      : r.content
          .replace(/^```[^\n]*$|^~~~[^\n]*$/gm, "")
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  if (Buffer.byteLength(text) > SEARCH_LIMITS.documentBytes) throw new SearchError("limit", 409);
  return {
    id: d.id,
    title: d.title,
    text,
    version: r.id,
    locale: d.locale,
    path: d.path,
    updatedAt: d.updatedAt,
    ancestors: value.ancestors,
  };
}
/** This is the only search adapter allowed to select file-backed project or principal-specific content authorities. */
export function documentSearchSource(options: {
  project: SavedQueries | ((owner: string) => Promise<SavedQueries>);
  personal(owner: string): Promise<SavedQueries>;
  authorizeProject(owner: string, project: string): Promise<void>;
}): SearchSource {
  const queries = (scope: SearchScope) =>
    scope.project === "personal"
      ? options.personal(scope.owner)
      : typeof options.project === "function"
        ? options.project(scope.owner)
        : Promise.resolve(options.project);
  const authorize = async (scope: SearchScope) => {
    if (scope.project !== "personal") await options.authorizeProject(scope.owner, scope.project);
    else await options.personal(scope.owner);
  };
  return {
    authorize,
    async head(scope) {
      await authorize(scope);
      return (await queries(scope)).searchHead(scope.project);
    },
    async snapshot(scope) {
      await authorize(scope);
      const value = await (await queries(scope)).savedSnapshot(scope.project);
      if (value.documents.length > SEARCH_LIMITS.documents) throw new SearchError("limit", 409);
      const documents = value.documents.map(projection);
      if (documents.reduce((n, d) => n + Buffer.byteLength(d.text), 0) > SEARCH_LIMITS.textBytes)
        throw new SearchError("limit", 409);
      await authorize(scope);
      return { commit: value.searchVersion, documents };
    },
    async current(scope, ids) {
      await authorize(scope);
      const documents = (await (await queries(scope)).savedBatch(scope.project, ids)).map(projection);
      await authorize(scope);
      return documents;
    },
  };
}
