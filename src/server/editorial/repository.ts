import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  EditorialApplicationIntent,
  EditorialProposal,
  EditorialReceipt,
} from "../../shared/editorial/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import { EditorialError } from "./errors.js";
import { migrateEditorial } from "./schema.js";
import { EditorialHistoryRepository } from "./history/repository.js";

const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");
/** Immutable proposals and application intents do not pretend that native source storage shares their transaction. */
export class EditorialRepository {
  private history: EditorialHistoryRepository;
  constructor(private db: Database) {
    migrateEditorial(db);
    this.history = new EditorialHistoryRepository(db);
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  existing(owner: string, id: string, request: string) {
    const row = this.db
      .query<{ owner: string; request: string }, [string]>("SELECT owner,request FROM editorial_proposals WHERE id=?")
      .get(id);
    if (!row) return null;
    if (row.owner !== owner) throw new EditorialError("notFound", 404);
    if (row.request !== request) throw new EditorialError("invalidInput", 409);
    return this.get(owner, id);
  }
  create(owner: string, request: string, proposal: EditorialProposal) {
    return this.transaction(() => {
      const existing = this.existing(owner, proposal.id, request);
      if (existing) return existing;
      const payload = JSON.stringify(proposal);
      this.db
        .query(
          "INSERT INTO editorial_proposals(id,documentId,owner,request,payload,digest,createdAt,sourceProjectId) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          proposal.id,
          proposal.source.documentId,
          owner,
          request,
          payload,
          digest(payload),
          proposal.createdAt,
          proposal.source.projectId ?? null,
        );
      this.history.insert(owner, proposal);
      return this.get(owner, proposal.id);
    });
  }
  historyPage(owner: string, documentId: string, before: string | null, projectId?: string) {
    return this.history.page(owner, documentId, before, projectId);
  }
  get(owner: string, id: string) {
    const row = this.db
      .query<{ payload: string; digest: string; documentId: string; sourceProjectId: string | null }, [string, string]>(
        "SELECT payload,digest,documentId,sourceProjectId FROM editorial_proposals WHERE id=? AND owner=?",
      )
      .get(id, owner);
    if (!row) throw new EditorialError("notFound", 404);
    if (digest(row.payload) !== row.digest) throw new EditorialError("unavailable", 503);
    const application = this.db
      .query<{ payload: string; digest: string; selection: string }, [string]>(
        "SELECT payload,digest,selection FROM editorial_applications WHERE proposalId=?",
      )
      .get(id);
    if (application && digest(application.payload) !== application.digest) throw new EditorialError("unavailable", 503);
    const proposal = JSON.parse(row.payload) as EditorialProposal,
      receipt = application ? (JSON.parse(application.payload) as EditorialReceipt) : null;
    if (
      proposal?.id !== id ||
      proposal.source?.documentId !== row.documentId ||
      (proposal.source.projectId ?? null) !== row.sourceProjectId
    )
      throw new EditorialError("unavailable", 503);
    if (
      receipt &&
      (receipt.proposalId !== id ||
        receipt.digest !== row.digest ||
        receipt.reviewer !== owner ||
        stableJson(receipt.source) !== stableJson(proposal.source) ||
        receipt.applied.documentId !== proposal.source.documentId ||
        receipt.applied.projectId !== proposal.source.projectId ||
        !Number.isSafeInteger(receipt.applied.version) ||
        receipt.applied.version < proposal.source.version ||
        (receipt.commit !== undefined && !/^[a-f0-9]{40}$/.test(receipt.commit)) ||
        JSON.stringify(receipt.selected) !== application!.selection)
    )
      throw new EditorialError("unavailable", 503);
    return { proposal, digest: row.digest, receipt, selection: application?.selection || null };
  }
  apply(receipt: EditorialReceipt, selection: string) {
    const payload = JSON.stringify(receipt);
    this.db
      .query("INSERT INTO editorial_applications(proposalId,selection,payload,digest) VALUES(?,?,?,?)")
      .run(receipt.proposalId, selection, payload, digest(payload));
  }
  list(owner: string, documentId: string, projectId?: string) {
    return this.db
      .query<{ id: string }, [string, string, string | null]>(
        "SELECT id FROM editorial_proposals WHERE owner=? AND documentId=? AND sourceProjectId IS ? ORDER BY createdAt DESC,rowid DESC LIMIT 50",
      )
      .all(owner, documentId, projectId ?? null)
      .map((row) => row.id);
  }
  intent(owner: string, id: string): EditorialApplicationIntent | null {
    const stored = this.get(owner, id),
      row = this.db
        .query<{ payload: string; digest: string }, [string]>(
          "SELECT payload,digest FROM editorial_application_intents WHERE proposalId=?",
        )
        .get(id);
    if (!row) return null;
    if (digest(row.payload) !== row.digest) throw new EditorialError("unavailable", 503);
    const intent = JSON.parse(row.payload) as EditorialApplicationIntent;
    if (
      intent.proposalId !== id ||
      intent.digest !== stored.digest ||
      intent.reviewer !== owner ||
      stableJson(intent.source) !== stableJson(stored.proposal.source) ||
      !Number.isSafeInteger(intent.appliedAt) ||
      intent.appliedAt < 0 ||
      !Array.isArray(intent.selected) ||
      !intent.selected.length ||
      intent.selected.length > 500 ||
      new Set(intent.selected).size !== intent.selected.length ||
      intent.selected.some((id) => typeof id !== "string" || !stored.proposal.edits.some((edit) => edit.id === id)) ||
      JSON.stringify(intent.selected) !== JSON.stringify(intent.selected.toSorted())
    )
      throw new EditorialError("unavailable", 503);
    return intent;
  }
  reserve(intent: EditorialApplicationIntent): EditorialApplicationIntent {
    return this.transaction(() => {
      const previous = this.intent(intent.reviewer, intent.proposalId);
      if (previous) {
        if (previous.digest !== intent.digest || JSON.stringify(previous.selected) !== JSON.stringify(intent.selected))
          throw new EditorialError("alreadyApplied", 409);
        return previous;
      }
      const payload = JSON.stringify(intent);
      this.db
        .query("INSERT INTO editorial_application_intents(proposalId,payload,digest) VALUES(?,?,?)")
        .run(intent.proposalId, payload, digest(payload));
      return this.intent(intent.reviewer, intent.proposalId)!;
    });
  }
}
