import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { LocalIndexEngine } from "./providers/local-engine.js";
import { createAnalyzer } from "./analyzers/registry.js";
import { analyzerPackage } from "../../shared/search/validation.js";
import { SEARCH_LIMITS, SearchError, type SearchDocument } from "../../shared/search/contracts.js";
import type { IndexReference } from "./ports.js";
import { IndexIntegrityError } from "./integrity.js";
import { projectSearchText } from "./providers/text-projection.js";
const root = process.argv[2];
if (!root || !isAbsolute(root)) throw Error("An absolute index root is required");
const engine = new LocalIndexEngine(root),
  active = new Map<number, AbortController>();
async function command(message: Record<string, unknown>) {
  const id = Number(message.id);
  if (!Number.isSafeInteger(id) || id < 1) return;
  if (message.method === "cancel") {
    active.get(id)?.abort();
    return;
  }
  const controller = new AbortController();
  active.set(id, controller);
  try {
    if (active.size > 16) throw new SearchError("limit");
    const p = message.params as Record<string, unknown>;
    let result: unknown;
    if (message.method === "health") result = await engine.health();
    else if (message.method === "build")
      result = await engine.build(
        String(p.name),
        p.documents as SearchDocument[],
        createAnalyzer(analyzerPackage(p.analyzer)),
        controller.signal,
        (completed, total) => process.stdout.write(JSON.stringify({ id, progress: { completed, total } }) + "\n"),
      );
    else if (message.method === "query")
      result = await engine.query(
        p.index as unknown as IndexReference,
        String(p.query),
        createAnalyzer(analyzerPackage(p.analyzer)),
        Math.min(Number(p.limit), SEARCH_LIMITS.candidates),
        controller.signal,
      );
    else if (message.method === "audit")
      result = await engine.audit(
        p.index as unknown as IndexReference,
        createAnalyzer(analyzerPackage(p.analyzer)),
        controller.signal,
      );
    else if (message.method === "project")
      result = projectSearchText(p.document as unknown as SearchDocument, createAnalyzer(analyzerPackage(p.analyzer)));
    else if (message.method === "drop") result = await engine.drop(p.index as unknown as IndexReference);
    else throw new SearchError("invalidInput");
    process.stdout.write(JSON.stringify({ id, result: result ?? null }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        id,
        error: error instanceof SearchError ? error.code : "unavailable",
        ...(error instanceof IndexIntegrityError ? { integrity: error.reason } : {}),
      }) + "\n",
    );
  } finally {
    active.delete(id);
  }
}
createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    if (Buffer.byteLength(line) > SEARCH_LIMITS.indexBytes) {
      process.exitCode = 1;
      return;
    }
    try {
      void command(JSON.parse(line));
    } catch {
      process.exitCode = 1;
    }
  })
  .on("close", () => {
    for (const task of active.values()) task.abort();
  });
