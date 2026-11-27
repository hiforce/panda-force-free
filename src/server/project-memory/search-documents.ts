import type { MemoryEntry } from "../../shared/project-memory/contracts.js";
import type { SearchDocument } from "../../shared/search/contracts.js";
import { createAnalyzer } from "../search/analyzers/registry.js";
import { ENGLISH_ANALYZER } from "../search/analyzers/english.js";
import { digest } from "./records.js";

/** Index identifiers and minimized search terms. Content and provenance are rehydrated only from authorized SQL. */
export const indexedMemoryVersion = (salt: string, version: string) => digest([salt, version]);

export function memorySearchDocuments(entries: MemoryEntry[], salt: string): SearchDocument[] {
  return entries.flatMap(({ id, key, title, scope, version, state }) =>
    state === "active" && version
      ? [
          {
            id,
            title: title ? key + " " + title : key,
            text: scope,
            version: indexedMemoryVersion(salt, version),
            locale: "und",
            path: "",
            updatedAt: 0,
            ancestors: [],
          },
        ]
      : [],
  );
}
export const memorySearchAnalyzer = createAnalyzer({
  ...ENGLISH_ANALYZER,
  id: "panda.project-memory",
  name: "Project memory",
  languages: ["en", "zh"],
  tokenizer: "segmenter",
});
