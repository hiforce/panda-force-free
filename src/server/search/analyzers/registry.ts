import { createHash } from "node:crypto";
import stem from "wink-porter2-stemmer";
import type { AnalyzerPackage } from "../../../shared/search/contracts.js";
import { analyzerPackage } from "../../../shared/search/validation.js";
import type { SearchAnalyzer } from "../ports.js";
import { ENGLISH_ANALYZER } from "./english.js";
export const analyzerDigest = (p: AnalyzerPackage) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
/** Packages contain bounded recipes, never executable code. Indexing and queries share the same pinned recipe. */
export function createAnalyzer(input: AnalyzerPackage): SearchAnalyzer {
  const descriptor = analyzerPackage(input),
    stop = new Set(descriptor.stopWords),
    segmenter =
      descriptor.tokenizer === "segmenter" ? new Intl.Segmenter(descriptor.locale, { granularity: "word" }) : null;
  return {
    descriptor,
    digest: analyzerDigest(descriptor),
    tokens(text) {
      const expanded = text
        .normalize("NFKC")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
      const words = segmenter
        ? [...segmenter.segment(expanded)].filter((x) => x.isWordLike).map((x) => x.segment)
        : expanded.match(/[\p{L}\p{N}]+/gu) || [];
      const exact = (text.match(/[a-zA-Z][a-zA-Z0-9_.-]*[_.][a-zA-Z0-9_.-]+/g) || []).map((x) => "=" + x.toLowerCase());
      return [
        ...exact,
        ...words.flatMap((word) => {
          const term = word.toLocaleLowerCase(descriptor.locale).normalize("NFD").replace(/\p{M}/gu, "");
          if (!term || term.length > 120 || stop.has(term)) return [];
          return [descriptor.stemming === "porter2" && /^[a-z]+$/.test(term) ? stem(term) : term];
        }),
      ];
    },
  };
}
export const builtinAnalyzer = () => createAnalyzer(ENGLISH_ANALYZER);
