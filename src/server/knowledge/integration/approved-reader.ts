import type { MetadataStore } from "../metadata-ports.js";
import { createHash } from "node:crypto";
import { readApprovedKnowledge } from "./approved-values.js";
import { selectedKnowledgeCatalog } from "./selected-catalog.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { DocumentProjectReads } from "../../documents/files/projects.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import type { SavedSourceText } from "../../../shared/content-sources/contracts.js";
import { projectKnowledgeFile, projectKnowledgeMarkdown } from "../../project-content/paths.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import {
  approvedKnowledgeSources,
  nativeKnowledgeSelection,
  type ApprovedKnowledgeSources,
} from "./approved-sources.js";
import type {
  KnowledgeAdmission,
  KnowledgeCatalog,
  KnowledgeCatalogEntry,
  KnowledgeReadScope,
  ApprovedKnowledgeReader,
} from "../catalog/contracts.js";
/** Workflow admission and current saved files jointly grant visibility. A knowledge JSON file alone is never sufficient. */
export class FileApprovedKnowledgeReader implements ApprovedKnowledgeReader {
  constructor(
    private catalog: MetadataStore<KnowledgeCatalog>,
    private projects: (scope: KnowledgeReadScope) => Promise<DocumentProjectReads>,
    private repairMetadata: (missing: readonly KnowledgeAdmission[]) => void,
    private originals?: (scope: KnowledgeReadScope) => Promise<FileOriginalQueries>,
  ) {}
  private async withScope<T>(
    scope: KnowledgeReadScope,
    work: (
      view: ProjectContentView | null,
      entries: KnowledgeCatalogEntry[],
      head: string,
      sources: ApprovedKnowledgeSources | null,
    ) => Promise<T>,
    selected?: {
      ids: readonly string[];
      originals: Map<string, Buffer>;
    },
    prepared?: ReadonlyMap<string, SavedSourceText>,
  ) {
    const select = async (view: ProjectContentView | null) =>
      selected
        ? selectedKnowledgeCatalog(this.catalog, scope, view, selected.ids, selected.originals)
        : Promise.resolve(await this.catalog.list(scope.owner, scope.project));
    const projects = await this.projects(scope),
      originals = await this.originals?.(scope);
    await projects.authorize(scope.project);
    const result = await projects.ifPresent(scope.project, async (project, view) => {
      const found = await select(view);
      if (found.incomplete) {
        this.repairMetadata(found.missing);
        throw new KnowledgeTaskError("unavailable");
      }
      if (!found.entries.length)
        return {
          value: await work(view, [], createHash("sha256").update(stableJson([])).digest("hex"), null),
        };
      const sources = await approvedKnowledgeSources(
        view,
        project.owned,
        scope.project,
        found.entries,
        originals,
        prepared,
      );
      const entries = found.entries
        .filter(
          ({ projection: item }) =>
            view.version(projectKnowledgeFile(item.id)) === item.recordBlob &&
            view.version(projectKnowledgeMarkdown(item.id)) === item.markdownBlob &&
            item.sources.every((source) => sources.matches(source)),
        )
        .sort((a, b) => (a.projection.id < b.projection.id ? -1 : a.projection.id > b.projection.id ? 1 : 0));
      const head = createHash("sha256")
        .update(
          stableJson(
            entries.map((entry) => [
              entry.outputDigest,
              entry.projection,
              entry.projection.sources.map((source) => [source.id, sources.ancestors(source.id)]),
            ]),
          ),
        )
        .digest("hex");
      return { value: await work(view, entries, head, sources) };
    });
    if (result !== null) {
      // Resolving a read adapter can carry current identity policy even when its filesystem reader is trusted.
      await (await this.projects(scope)).authorize(scope.project);
      return result.value;
    }
    const found = await select(null);
    if (found.incomplete || found.entries.length) {
      this.repairMetadata(found.missing);
      throw new KnowledgeTaskError("unavailable");
    }
    await (await this.projects(scope)).authorize(scope.project);
    return work(null, [], createHash("sha256").update(stableJson([])).digest("hex"), null);
  }
  head(scope: KnowledgeReadScope) {
    return this.withScope(scope, async (_view, _entries, head) => head);
  }
  snapshot(scope: KnowledgeReadScope) {
    return this.hydrate(scope);
  }
  current(scope: KnowledgeReadScope, ids: readonly string[]) {
    if (ids.length > 1000) throw new KnowledgeTaskError("budget");
    return this.hydrate(scope, ids).then((value) => value.records);
  }
  private async hydrate(scope: KnowledgeReadScope, ids?: readonly string[]) {
    const selected = ids ? { ids, originals: new Map<string, Buffer>() } : undefined,
      first = await this.withScope(
        scope,
        async (view, entries, head, sources) => {
          const selection = nativeKnowledgeSelection(entries);
          if (selection.ids.length) return { stage: { head, selection } };
          return {
            value: { commit: head, records: await readApprovedKnowledge(view, entries, sources, selected?.originals) },
          };
        },
        selected,
      );
    if (first.value) return first.value;
    const { head, selection } = first.stage!,
      originals = await this.originals?.(scope);
    if (!originals) throw new KnowledgeTaskError("unavailable");
    const prepared = new Map(
      (await originals.current(scope.project, selection.ids, selection.kinds)).map((value) => [
        value.metadata.id,
        value,
      ]),
    );
    return this.withScope(
      scope,
      async (view, entries, currentHead, sources) => {
        if (currentHead !== head) throw new KnowledgeTaskError("conflict");
        return {
          commit: currentHead,
          records: await readApprovedKnowledge(view, entries, sources, selected?.originals),
        };
      },
      selected,
      prepared,
    );
  }
}
