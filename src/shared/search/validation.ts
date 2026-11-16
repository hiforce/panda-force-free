import { SearchError, type AnalyzerPackage, type SearchSettings } from "./contracts.js";
import type { SavedSourceKind } from "../content-sources/contracts.js";
import { selectedSourceKinds } from "../content-sources/selection.js";

export function searchContentKinds(value: unknown): SavedSourceKind[] {
  const kinds = selectedSourceKinds(value);
  if (!kinds) throw new SearchError("invalidInput");
  return kinds;
}
export function searchRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k)))
    throw new SearchError("invalidInput");
  return value as Record<string, unknown>;
}
export function searchText(value: unknown, max = 300): string {
  if (typeof value !== "string" || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new SearchError("invalidInput");
  return value.normalize("NFC");
}
export function searchId(value: unknown): string {
  const id = searchText(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new SearchError("invalidInput");
  return id;
}
export function analyzerPackage(value: unknown): AnalyzerPackage {
  const p = searchRecord(value, [
    "schema",
    "kind",
    "id",
    "version",
    "name",
    "languages",
    "tokenizer",
    "locale",
    "stemming",
    "stopWords",
  ]);
  if (
    p.schema !== 1 ||
    p.kind !== "panda-search-analyzer" ||
    !["unicode", "segmenter"].includes(String(p.tokenizer)) ||
    !["none", "porter2"].includes(String(p.stemming))
  )
    throw new SearchError("invalidInput");
  const locale = searchText(p.locale, 64);
  try {
    if (Intl.Segmenter.supportedLocalesOf([locale]).length !== 1) throw Error();
  } catch {
    throw new SearchError("configuration");
  }
  if (
    !Array.isArray(p.languages) ||
    !p.languages.length ||
    p.languages.length > 32 ||
    !Array.isArray(p.stopWords) ||
    p.stopWords.length > 5000
  )
    throw new SearchError("invalidInput");
  const version = searchText(p.version, 40);
  if (!/^\d+\.\d+\.\d+$/.test(version) || (p.stemming === "porter2" && !/^en(?:-|$)/i.test(locale)))
    throw new SearchError("invalidInput");
  return {
    schema: 1,
    kind: "panda-search-analyzer",
    id: searchId(p.id),
    version,
    name: searchText(p.name, 120),
    languages: p.languages.map((x) => searchText(x, 64)),
    tokenizer: p.tokenizer as AnalyzerPackage["tokenizer"],
    locale,
    stemming: p.stemming as AnalyzerPackage["stemming"],
    stopWords: [...new Set(p.stopWords.map((x) => searchText(x, 80).toLowerCase()))],
  };
}
export const DEFAULT_SEARCH_SETTINGS: SearchSettings = Object.freeze({
  enabled: false,
  fulltext: true,
  vector: false,
  analyzer: "panda.english@1.0.0",
  include: [],
  exclude: [],
  knowledge: { mode: "manual" as const, documents: [], subtrees: [], exclude: [] },
});
export function searchSettings(value: unknown): SearchSettings {
  const p = searchRecord(value, [
    "enabled",
    "fulltext",
    "vector",
    "analyzer",
    "include",
    "exclude",
    "knowledge",
    "contentKinds",
  ]);
  if ([p.enabled, p.fulltext, p.vector].some((x) => typeof x !== "boolean")) throw new SearchError("invalidInput");
  const paths = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 64) throw new SearchError("invalidInput");
    return v.map((x) => {
      const s = searchText(x, 300);
      if (s.startsWith("/") || s.split("/").includes("..") || s.includes("\\")) throw new SearchError("invalidInput");
      return s;
    });
  };
  const k = searchRecord(p.knowledge, ["mode", "documents", "subtrees", "exclude"]);
  if (!["manual", "selected", "project"].includes(String(k.mode))) throw new SearchError("invalidInput");
  const ids = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 1000) throw new SearchError("invalidInput");
    return [...new Set(v.map(searchId))];
  };
  return {
    enabled: p.enabled as boolean,
    fulltext: p.fulltext as boolean,
    vector: p.vector as boolean,
    analyzer: searchText(p.analyzer, 180),
    include: paths(p.include),
    exclude: paths(p.exclude),
    knowledge: {
      mode: k.mode as SearchSettings["knowledge"]["mode"],
      documents: ids(k.documents),
      subtrees: ids(k.subtrees),
      exclude: ids(k.exclude),
    },
    ...(p.contentKinds === undefined ? {} : { contentKinds: searchContentKinds(p.contentKinds) }),
  };
}
