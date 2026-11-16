import type { KnowledgeSelection, KnowledgeTaskInput } from "../../../shared/knowledge/tasks.js";
import type { SavedSourceText } from "../../../shared/content-sources/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import type { OwnedProjectDirectory } from "../../project-content/owned-directory.js";
import { projectDocumentFile } from "../../project-content/paths.js";
import type { ProjectGitSnapshots } from "../../project-content/git/snapshot.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import { DocumentError } from "../../documents/errors.js";
import { savedKnowledgeDocuments } from "./saved-documents.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";

export const knowledgeSourcePath = (source: KnowledgeTaskInput["sources"][number]) =>
  source.binding?.path ?? projectDocumentFile(source.id);

/** Pure projections are prepared outside the lease; the final view rechecks their exact saved bindings and raw bytes. */
export class KnowledgeSourceContext {
  constructor(private readonly originals?: FileOriginalQueries) {}
  async prepare(selection: KnowledgeSelection): Promise<SavedSourceText[] | null> {
    if (!selection.contentKinds?.some((kind) => kind !== "document")) return null;
    if (!this.originals) throw new KnowledgeTaskError("unavailable");
    return this.originals.current(selection.project, selection.ids, selection.contentKinds);
  }
  async read(
    view: ProjectContentView,
    owned: OwnedProjectDirectory,
    selection: KnowledgeSelection,
    prepared: SavedSourceText[] | null,
  ): Promise<KnowledgeTaskInput["sources"]> {
    if (prepared === null) {
      const saved = await savedKnowledgeDocuments(view, selection.project, new Set(selection.ids));
      return Promise.all(
        selection.ids.map(async (id) => {
          if (!saved.documents.has(id)) throw new DocumentError("notFound", 404);
          return (await saved.read(id)).source;
        }),
      );
    }
    if (!this.originals) throw new KnowledgeTaskError("unavailable");
    const current = await this.originals.saved(
        view,
        owned,
        selection.project,
        selection.contentKinds!,
        new Set(selection.ids),
      ),
      metadata = new Map(current.entries.map((entry) => [entry.id, entry])),
      projections = new Map(prepared.map((entry) => [entry.metadata.id, entry]));
    if (metadata.size !== selection.ids.length) throw new DocumentError("notFound", 404);
    if (prepared.length !== selection.ids.length) throw new KnowledgeTaskError("conflict");
    const sources: KnowledgeTaskInput["sources"] = [];
    for (const id of selection.ids) {
      const value = projections.get(id),
        identity = metadata.get(id);
      if (!value || !identity || stableJson(identity) !== stableJson(value.metadata))
        throw new KnowledgeTaskError("conflict");
      // Documents retain full saved-body verification. Native parsing never runs inside this final lease.
      let text = value.text,
        sections = value.sections;
      if (identity.binding.kind === "document") {
        const captured = await current.prepare(id);
        if (!("text" in captured)) throw new KnowledgeTaskError("conflict");
        text = captured.text.text;
        sections = captured.text.sections;
      } else await current.verify(id);
      sources.push({
        id,
        version: identity.version,
        kind: "asset",
        title: identity.title,
        text,
        sections: structuredClone(sections),
        ...(identity.binding.kind === "document" ? {} : { binding: structuredClone(identity.binding) }),
      });
    }
    view.assertHeld();
    return sources;
  }
  async unchanged(
    view: ProjectContentView,
    owned: OwnedProjectDirectory,
    input: KnowledgeTaskInput,
    snapshots: ProjectGitSnapshots,
    prepared: SavedSourceText[] | null,
  ) {
    const now = await this.read(view, owned, input.scope, prepared).catch((error) => {
      if (error instanceof KnowledgeTaskError && error.code === "conflict") return null;
      throw error;
    });
    if (!now) return false;
    const original = new Map((await snapshots.entries(input.sourceCommit)).map((entry) => [entry.path, entry.blob]));
    return (
      now.length === input.sources.length &&
      now.every((source, index) => {
        const previous = input.sources[index]!,
          path = knowledgeSourcePath(source);
        return (
          source.id === previous.id &&
          source.version === previous.version &&
          source.text === previous.text &&
          (!source.binding || stableJson(source) === stableJson(previous)) &&
          stableJson(source.binding ?? null) === stableJson(previous.binding ?? null) &&
          original.get(path) === view.version(path)
        );
      })
    );
  }
}
