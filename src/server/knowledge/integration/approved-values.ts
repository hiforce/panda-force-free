import type { KnowledgeEvidenceSource } from "../../../shared/knowledge/contracts.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import { projectKnowledgeFile, projectKnowledgeMarkdown } from "../../project-content/paths.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { knowledgeRecord } from "../tasks/record.js";
import { knowledgeValueDigest } from "../identity.js";
import { knowledgeMarkdown } from "./markdown.js";
import { assertKnowledgeAssetEvidence } from "../asset-evidence.js";
import type { ApprovedKnowledgeSources } from "./approved-sources.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { KnowledgeCatalogEntry, ApprovedKnowledgeValue } from "../catalog/contracts.js";

/** Both full snapshots and selected reads validate the same saved output, admission and original evidence. */
export async function readApprovedKnowledge(
  view: ProjectContentView | null,
  entries: KnowledgeCatalogEntry[],
  sourceReads: ApprovedKnowledgeSources | null,
  originals?: ReadonlyMap<string, Buffer>,
): Promise<ApprovedKnowledgeValue[]> {
  if (!view) {
    if (entries.length) throw new KnowledgeTaskError("unavailable");
    return [];
  }
  const sourceCache = new Map<string, KnowledgeEvidenceSource>(),
    metadata = new Map<string, { title: string; path: string; ancestors: string[] }>(),
    values: ApprovedKnowledgeValue[] = [];
  let bytes = 0;
  for (const accepted of entries) {
    const item = accepted.projection,
      original = originals?.get(item.id) ?? (await view.read(projectKnowledgeFile(item.id))),
      markdown = await view.read(projectKnowledgeMarkdown(item.id));
    if (!original || !markdown) throw new KnowledgeTaskError("unavailable");
    bytes += original.length + markdown.length;
    if (bytes > 32 * 1024 * 1024) throw new KnowledgeTaskError("budget");
    const record = knowledgeRecord(JSON.parse(original.toString("utf8")));
    if (
      record.id !== item.id ||
      record.version !== item.version ||
      record.taskId !== accepted.taskId ||
      record.sourceCommit !== item.sourceCommit ||
      knowledgeValueDigest(record) !== accepted.outputDigest ||
      !markdown.equals(Buffer.from(knowledgeMarkdown(record)))
    )
      throw new KnowledgeTaskError("unavailable");
    const sources: KnowledgeEvidenceSource[] = [];
    for (const binding of item.sources) {
      let source = sourceCache.get(binding.id);
      if (!source) {
        if (!sourceReads) throw new KnowledgeTaskError("unavailable");
        const saved = await sourceReads.read(binding);
        source = saved.source;
        metadata.set(binding.id, {
          title: saved.title,
          path: saved.path,
          ancestors: saved.ancestors,
        });
        sourceCache.set(binding.id, source);
      }
      if (
        source.version !== binding.version ||
        stableJson(source.binding ?? null) !== stableJson(binding.binding ?? null)
      )
        throw new KnowledgeTaskError("conflict");
      sources.push(source);
    }
    const assetMetadata = record.sources.filter((source) => source.kind === "asset");
    if (
      assetMetadata.length !== sources.length ||
      !assetMetadata.every((source) =>
        sources.some(
          (item) =>
            item.id === source.id &&
            item.version === source.version &&
            stableJson(item.binding ?? null) === stableJson(source.binding ?? null),
        ),
      )
    )
      throw new KnowledgeTaskError("unavailable");
    assertKnowledgeAssetEvidence(record, sources);
    values.push({
      record,
      sources: item.sources.map((source) => ({ ...source, ...metadata.get(source.id)! })),
      receipt: accepted.receipt,
    });
  }
  view.assertHeld();
  return values;
}
