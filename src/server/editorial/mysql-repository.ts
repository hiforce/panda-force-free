import type { MySQLEditorialSession } from "./mysql-session.js";
import { createHash } from "node:crypto";
import type {
  EditorialApplicationIntent,
  EditorialProposal,
  EditorialReceipt,
} from "../../shared/editorial/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import { EditorialError } from "./errors.js";
import { MySQLEditorialHistoryRepository } from "./history/mysql-repository.js";
const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");
/** Immutable proposals and application intents do not pretend that native source storage shares their transaction. */
export class MySQLEditorialRepository {
  private history: MySQLEditorialHistoryRepository;
  constructor(private db: MySQLEditorialSession) {
    this.history = new MySQLEditorialHistoryRepository(db);
  }
  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
  async existing(owner: string, id: string, request: string) {
    const row = await this.db.one<{
      owner: string;
      request: string;
    }>("SELECT owner,request FROM panda_force_editorial_proposals WHERE id=?", [id]);
    if (!row) return null;
    if (row.owner !== owner) throw new EditorialError("notFound", 404);
    if (row.request !== request) throw new EditorialError("invalidInput", 409);
    return await this.get(owner, id);
  }
  async create(owner: string, request: string, proposal: EditorialProposal) {
    return await this.transaction(async () => {
      const existing = await this.existing(owner, proposal.id, request);
      if (existing) return existing;
      const payload = JSON.stringify(proposal);
      await this.db.run(
        "INSERT INTO panda_force_editorial_proposals(id,documentId,owner,request,payload,digest,createdAt,sourceProjectId) VALUES(?,?,?,?,?,?,?,?)",
        [
          proposal.id,
          proposal.source.documentId,
          owner,
          request,
          payload,
          digest(payload),
          proposal.createdAt,
          proposal.source.projectId ?? null,
        ],
      );
      await this.history.insert(owner, proposal);
      return await this.get(owner, proposal.id);
    });
  }
  async historyPage(owner: string, documentId: string, before: string | null, projectId?: string) {
    return await this.history.page(owner, documentId, before, projectId);
  }
  async get(owner: string, id: string) {
    return this.db.snapshot(async () => {
      const row = await this.db.one<{
        payload: string;
        digest: string;
        documentId: string;
        sourceProjectId: string | null;
      }>(
        "SELECT payload,digest,documentId,sourceProjectId FROM panda_force_editorial_proposals WHERE id=? AND owner=?",
        [id, owner],
      );
      if (!row) throw new EditorialError("notFound", 404);
      if (digest(row.payload) !== row.digest) throw new EditorialError("unavailable", 503);
      const application = await this.db.one<{
        payload: string;
        digest: string;
        selection: string;
      }>("SELECT payload,digest,selection FROM panda_force_editorial_applications WHERE proposalId=?", [id]);
      if (application && digest(application.payload) !== application.digest)
        throw new EditorialError("unavailable", 503);
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
    });
  }
  async apply(receipt: EditorialReceipt, selection: string) {
    const payload = JSON.stringify(receipt);
    await this.db.run(
      "INSERT INTO panda_force_editorial_applications(proposalId,selection,payload,digest) VALUES(?,?,?,?)",
      [receipt.proposalId, selection, payload, digest(payload)],
    );
  }
  async list(owner: string, documentId: string, projectId?: string) {
    return (
      await this.db.all<{
        id: string;
      }>(
        "SELECT id FROM panda_force_editorial_proposals WHERE owner=? AND documentId=? AND sourceProjectId <=> ? ORDER BY createdAt DESC,sequence DESC LIMIT 50",
        [owner, documentId, projectId ?? null],
      )
    ).map((row) => row.id);
  }
  async intent(owner: string, id: string): Promise<EditorialApplicationIntent | null> {
    return this.db.snapshot(async () => {
      const stored = await this.get(owner, id),
        row = await this.db.one<{
          payload: string;
          digest: string;
        }>("SELECT payload,digest FROM panda_force_editorial_application_intents WHERE proposalId=?", [id]);
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
    });
  }
  async reserve(intent: EditorialApplicationIntent): Promise<EditorialApplicationIntent> {
    return await this.transaction(async () => {
      const previous = await this.intent(intent.reviewer, intent.proposalId);
      if (previous) {
        if (previous.digest !== intent.digest || JSON.stringify(previous.selected) !== JSON.stringify(intent.selected))
          throw new EditorialError("alreadyApplied", 409);
        return previous;
      }
      const payload = JSON.stringify(intent);
      await this.db.run(
        "INSERT INTO panda_force_editorial_application_intents(proposalId,payload,digest) VALUES(?,?,?)",
        [intent.proposalId, payload, digest(payload)],
      );
      return (await this.intent(intent.reviewer, intent.proposalId))!;
    });
  }
}
