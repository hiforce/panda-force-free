import type { EditorialApplicationIntent, EditorialReceipt } from "../../shared/editorial/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import type { AsyncEditorialCompletion, AsyncEditorialSources } from "./async-ports.js";
import type { MySQLEditorialRepository } from "./mysql-repository.js";
import { EditorialError } from "./errors.js";
import { editorialValue } from "./input.js";
import { editorialBody } from "./patch.js";
type StoredReview = Awaited<ReturnType<MySQLEditorialRepository["get"]>>;
/** User confirmation is durable before native source work. Reconciliation only observes an existing native receipt. */
export class MySQLEditorialApplications {
  constructor(
    private repository: MySQLEditorialRepository,
    private sources: AsyncEditorialSources,
  ) {}
  private async body(
    stored: StoredReview,
    intent: EditorialApplicationIntent,
    source: Awaited<ReturnType<AsyncEditorialSources["revision"]>>,
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
  private async completion(
    intent: EditorialApplicationIntent,
    assertCurrent: () => void | Promise<void>,
  ): Promise<AsyncEditorialCompletion> {
    const receipt = async () => {
      await assertCurrent();
      const stored = await this.repository.get(intent.reviewer, intent.proposalId);
      if (stored.digest !== intent.digest) throw new EditorialError("staleProposal", 409);
      if (stored.receipt && stored.selection !== JSON.stringify(intent.selected))
        throw new EditorialError("alreadyApplied", 409);
      return stored.receipt;
    };
    return {
      receipt,
      record: async (applied) =>
        await this.repository.transaction(async () => {
          const previous = await receipt();
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
          await this.repository.apply(result, JSON.stringify(intent.selected));
          return result;
        }),
    };
  }
  async recover(owner: string, stored: StoredReview, assertCurrent: () => void | Promise<void>) {
    if (stored.receipt) return stored;
    const intent = await this.repository.intent(owner, stored.proposal.id);
    if (!intent) return stored;
    const source = await this.sources.revision(
        intent.source.documentId,
        intent.source.revisionId,
        intent.source.projectId,
      ),
      applied = await this.sources.applied(intent, await this.body(stored, intent, source));
    await assertCurrent();
    if (applied) await (await this.completion(intent, assertCurrent)).record(applied);
    return await this.repository.get(owner, stored.proposal.id);
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
      stored = await this.repository.get(owner, id),
      sourceRef = stored.proposal.source;
    if (stored.digest !== expected) throw new EditorialError("staleProposal", 409);
    const assertCurrent = await this.sources.authorize(sourceRef.documentId, sourceRef.projectId);
    await assertCurrent();
    if (stored.receipt) {
      if (stored.selection !== JSON.stringify(selected)) throw new EditorialError("alreadyApplied", 409);
      return stored.receipt;
    }
    let intent = await this.repository.intent(owner, id);
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
    const body = await this.body(stored, proposed, source);
    if (!intent) {
      if (stableJson(await this.sources.current(sourceRef.documentId, sourceRef.projectId)) !== stableJson(sourceRef))
        throw new EditorialError("staleSource", 409);
      intent = await this.repository.transaction(async () => {
        await assertCurrent();
        return await this.repository.reserve(proposed);
      });
    }
    await assertCurrent();
    return await this.sources.apply(intent, body, await this.completion(intent, assertCurrent));
  }
}
