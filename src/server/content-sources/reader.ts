import type { ProjectContentView } from "../project-content/read-view.js";
import type { OwnedProjectDirectory } from "../project-content/owned-directory.js";
import type { SavedSourceKind, SavedSourceText } from "../../shared/content-sources/contracts.js";
import { SAVED_SOURCE_LIMITS as limits } from "../../shared/content-sources/contracts.js";
import type { DocumentProjectReads } from "../documents/files/projects.js";
import { documentFileOperation } from "../documents/files/errors.js";
import { ProjectContentError } from "../project-content/errors.js";
import type { SavedOriginalSources } from "./saved.js";
import { savedOriginalSources } from "./saved.js";
import { savedSourceSelection } from "./selection.js";
import { materializeSavedSource, type PreparedSavedSource, type SavedSourceParser } from "./prepared.js";
import { assertSavedSourceMetadata, savedSourceBatches, SAVED_SOURCE_BATCH_LIMITS } from "./batches.js";

/** Read-only source queries cannot initialize personal roots, editing services or model workers. */
export class FileOriginalQueries {
  constructor(
    private readonly projects: DocumentProjectReads,
    private readonly assetRoot: string,
    private readonly parse?: SavedSourceParser,
  ) {}
  /** Internal writers can reuse the neutral saved-source verifier under their existing final lease. */
  saved(
    view: ProjectContentView,
    owned: OwnedProjectDirectory,
    project: string,
    kinds: readonly SavedSourceKind[],
    ids?: ReadonlySet<string>,
  ) {
    return savedOriginalSources(view, owned, this.assetRoot, project, kinds, ids);
  }
  private read<T>(
    project: string,
    kinds: readonly SavedSourceKind[],
    ids: ReadonlySet<string> | undefined,
    work: (sources: SavedOriginalSources) => Promise<T>,
  ) {
    const selection = savedSourceSelection(kinds, ids);
    return documentFileOperation(async () => {
      await this.projects.authorize(project);
      const result = await this.projects.ifPresent(project, async (owner, view) => ({
        value: await work(
          await savedOriginalSources(view, owner.owned, this.assetRoot, project, selection.kinds, selection.ids),
        ),
      }));
      await this.projects.authorize(project);
      return result;
    });
  }
  async metadata(project: string, kinds: readonly SavedSourceKind[] = ["document"], ids?: ReadonlySet<string>) {
    return (
      (await this.read(project, kinds, ids, async (source) => ({ head: source.head, entries: source.entries })))
        ?.value ?? { head: "empty", entries: [] }
    );
  }
  async snapshot(project: string, kinds: readonly SavedSourceKind[] = ["document"], signal?: AbortSignal) {
    return this.collect(project, kinds, undefined, signal);
  }
  async current(
    project: string,
    ids: readonly string[],
    kinds: readonly SavedSourceKind[] = ["document"],
    signal?: AbortSignal,
  ) {
    if (ids.length > limits.selected || new Set(ids).size !== ids.length) throw new ProjectContentError("tooLarge");
    return (await this.collect(project, kinds, new Set(ids), signal)).sources;
  }
  private async collect(
    project: string,
    kinds: readonly SavedSourceKind[],
    ids?: ReadonlySet<string>,
    signal?: AbortSignal,
  ) {
    const selection = savedSourceSelection(kinds, ids);
    return documentFileOperation(async () => {
      const check = () => {
        if (signal?.aborted) throw new ProjectContentError("unavailable");
      };
      check();
      const initial = await this.metadata(project, selection.kinds, selection.ids),
        values: SavedSourceText[] = [];
      let bytes = 0;
      for (const batch of savedSourceBatches(initial.entries)) {
        check();
        const captured = await this.read(
          project,
          selection.kinds,
          new Set(batch.map((row) => row.id)),
          async (source) => {
            assertSavedSourceMetadata(batch, source.entries);
            const prepared: PreparedSavedSource[] = [];
            let retained = 0;
            for (const row of batch) {
              const value = await source.prepare(row.id, signal);
              retained += value.bytes;
              if (retained > SAVED_SOURCE_BATCH_LIMITS.preparedBytes) throw new ProjectContentError("tooLarge");
              prepared.push(value);
            }
            return prepared;
          },
        );
        if (!captured) throw new ProjectContentError("conflict");
        // All original bytes are verified before this lease-free worker phase.
        for (const prepared of captured.value) {
          check();
          const value = await materializeSavedSource(prepared, signal, this.parse);
          bytes += Buffer.byteLength(value.text);
          if (bytes > limits.textBytes) throw new ProjectContentError("tooLarge");
          values.push(value);
        }
      }
      for (const batch of savedSourceBatches(initial.entries)) {
        check();
        const verified = await this.read(
          project,
          selection.kinds,
          new Set(batch.map((row) => row.id)),
          async (source) => {
            assertSavedSourceMetadata(batch, source.entries);
            for (const row of batch) await source.verify(row.id, signal);
            return true;
          },
        );
        if (!verified) throw new ProjectContentError("conflict");
      }
      const current = await this.metadata(project, selection.kinds, selection.ids);
      if (current.head !== initial.head) throw new ProjectContentError("conflict");
      await this.projects.authorize(project);
      check();
      return { head: initial.head, sources: values };
    });
  }
}
