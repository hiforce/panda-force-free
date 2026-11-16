import type { SavedSourceKind } from "../../shared/content-sources/contracts.js";
import { selectedSourceKinds } from "../../shared/content-sources/selection.js";

export interface KnowledgePendingSubmission {
  id: string;
  project: string;
  ids: string[];
  purpose: string;
  contentKinds?: SavedSourceKind[];
}

/** An ambiguous network result retries the same immutable operation instead of creating a second task. */
export class KnowledgeSubmission {
  private readonly key: string;
  private value: KnowledgePendingSubmission | null = null;
  constructor(
    identity: string,
    private readonly project: string,
  ) {
    this.key = "panda-knowledge-submission:" + encodeURIComponent(identity) + ":" + encodeURIComponent(project);
    try {
      const stored = localStorage.getItem(this.key);
      if (stored && stored.length > 18000) return;
      const value = JSON.parse(stored || "null"),
        kinds = selectedSourceKinds(value?.contentKinds);
      if (
        value?.project === project &&
        typeof value.id === "string" &&
        value.id.length <= 128 &&
        typeof value.purpose === "string" &&
        value.purpose.length <= 4096 &&
        Array.isArray(value.ids) &&
        value.ids.length > 0 &&
        value.ids.length <= 32 &&
        value.ids.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 128) &&
        new Set(value.ids).size === value.ids.length &&
        kinds
      )
        this.value = {
          id: value.id,
          project,
          ids: [...value.ids],
          purpose: value.purpose,
          ...(value.contentKinds === undefined ? {} : { contentKinds: kinds }),
        };
    } catch {
      /* Unavailable browser storage does not prevent a bounded in-memory submission. */
    }
  }
  get pending() {
    return this.value;
  }
  begin(ids: string[], purpose: string, contentKinds?: SavedSourceKind[]) {
    this.value ??= {
      id: crypto.randomUUID(),
      project: this.project,
      ids: [...ids].sort(),
      purpose,
      ...(contentKinds ? { contentKinds: [...contentKinds] } : {}),
    };
    try {
      localStorage.setItem(this.key, JSON.stringify(this.value));
    } catch {
      /* Retain the same operation in memory. */
    }
    return this.value;
  }
  acknowledge() {
    this.value = null;
    try {
      localStorage.removeItem(this.key);
    } catch {
      /* The server also deduplicates a stale persisted retry. */
    }
  }
}
