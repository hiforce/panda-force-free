import type { AnalyzerPackage } from "../../../shared/search/contracts.js";
export const ENGLISH_ANALYZER: AnalyzerPackage = Object.freeze({
  schema: 1,
  kind: "panda-search-analyzer",
  id: "panda.english",
  version: "1.0.0",
  name: "English",
  languages: ["en"],
  locale: "en",
  tokenizer: "unicode",
  stemming: "porter2",
  stopWords:
    "a an and are as at be been being but by for from had has have he her hers him his i in into is it its me my of on or our ours she that the their them they this those to us was we were what which who will with you your".split(
      " ",
    ),
});
