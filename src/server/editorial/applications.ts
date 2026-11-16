import type { EditorialApplicationIntent, EditorialReceipt } from "../../shared/editorial/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import type { EditorialCompletion, EditorialSources } from "./ports.js";
import type { EditorialRepository } from "./repository.js";
import { EditorialError } from "./errors.js";
import { editorialValue } from "./input.js";
import { editorialBody } from "./patch.js";

type StoredReview = ReturnType<EditorialRepository["get"]>;
/** User confirmation is durable before native source work. Reconciliation only observes an existing native receipt. */
export class EditorialApplications {
  constructor(
    private repository: EditorialRepository,
    private sources: EditorialSources,
  ) {}

  private body(
    stored: StoredReview,
    intent: EditorialApplicationIntent,
    source: Awaited<ReturnType<EditorialSources["revision"]>>,
  ) {
    if (stableJson(source.ref) !== stableJson(intent.source)) throw new EditorialError("staleSource", 409);
    return editorialBody(
      source.body,
      intent.selected.map((id) => {
        const edit = stored.proposal.edits.find((edit) => edit.id === id);
        if (!edit) throw new EditorialError("invalidInput");
        return edit;
      }),
    );
  }
  private completion(intent: EditorialApplicationIntent, assertCurrent: () => void): EditorialCompletion {
    const receipt = () => {
      assertCurrent();
      const stored = this.repository.get(intent.reviewer, intent.proposalId);
      if (stored.digest !== intent.digest) throw new EditorialError("staleProposal", 409);
      if (stored.receipt && stored.selection !== JSON.stringify(intent.selected))
        throw new EditorialError("alreadyApplied", 409);
      return stored.receipt;
    };
    return {
      receipt,
      record: (applied) =>
        this.repository.transaction(() => {
          const previous = receipt();
          if (previous) return previous;
          if (
            applied.ref.documentId !== intent.source.documentId ||
            applied.ref.projectId !== intent.source.projectId ||
            applied.ref.version < intent.source.version ||
            (applied.commit !== undefined && !/^[a-f0-9]{40}$/.test(applied.commit))
          )
            throw new EditorialError("unavailable", 503);
          const result: EditorialReceipt = {
            ...intent,
            applied: applied.ref,
            ...(applied.commit ? { commit: applied.commit } : {}),
          };
          this.repository.apply(result, JSON.stringify(intent.selected));
          return result;
        }),
    };
  }
  async recover(owner: string, stored: StoredReview, assertCurrent: () => void) {
    if (stored.receipt) return stored;
    const intent = this.repository.intent(owner, stored.proposal.id);
    if (!intent) return stored;
    const source = await this.sources.revision(
        intent.source.documentId,
        intent.source.revisionId,
        intent.source.projectId,
      ),
      applied = await this.sources.applied(intent, this.body(stored, intent, source));
    assertCurrent();
    if (applied) this.completion(intent, assertCurrent).record(applied);
    return this.repository.get(owner, stored.proposal.id);
  }
  async accept(owner: string, input: Record<string, unknown>) {
    owner = editorialValue(owner, 200);
    if (
      Object.keys(input).some((key) => !["id", "digest", "selected"].includes(key)) ||
      !Array.isArray(input.selected) ||
      !input.selected.length ||
      input.selected.length > 500 ||
      input.selected.some((id) => typeof id !== "string") ||
      new Set(input.selected).size !== input.selected.length
    )
      throw new EditorialError("invalidInput");
    const id = editorialValue(input.id),
      expected = editorialValue(input.digest),
      selected = (input.selected as string[]).toSorted(),
      stored = this.repository.get(owner, id),
      sourceRef = stored.proposal.source;
    if (stored.digest !== expected) throw new EditorialError("staleProposal", 409);
    const assertCurrent = await this.sources.authorize(sourceRef.documentId, sourceRef.projectId);
    assertCurrent();
    if (stored.receipt) {
      if (stored.selection !== JSON.stringify(selected)) throw new EditorialError("alreadyApplied", 409);
      return stored.receipt;
    }
    let intent = this.repository.intent(owner, id);
    if (intent && JSON.stringify(intent.selected) !== JSON.stringify(selected))
      throw new EditorialError("alreadyApplied", 409);
    const source = await this.sources.revision(sourceRef.documentId, sourceRef.revisionId, sourceRef.projectId);
    const proposed: EditorialApplicationIntent = intent ?? {
      proposalId: id,
      digest: expected,
      source: sourceRef,
      selected,
      reviewer: owner,
      appliedAt: Date.now(),
    };
    const body = this.body(stored, proposed, source);
    if (!intent) {
      if (stableJson(await this.sources.current(sourceRef.documentId, sourceRef.projectId)) !== stableJson(sourceRef))
        throw new EditorialError("staleSource", 409);
      intent = this.repository.transaction(() => {
        assertCurrent();
        return this.repository.reserve(proposed);
      });
    }
    assertCurrent();
    return this.sources.apply(intent, body, this.completion(intent, assertCurrent));
  }
}
