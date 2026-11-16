import type { AsyncStore } from "../../../shared/async-store.js";
import type { JsonValue } from "../../../shared/delivery/workflow.js";
import { DeliveryError } from "../errors.js";
import type { MySQLWorkflowRepository } from "../storage/mysql-workflows.js";
import type { AsyncSocialSources } from "./async-ports.js";
import { mysqlCurrentBoundTarget } from "./mysql-target-binding.js";
import { socialPayload } from "./payload.js";
import type { SocialAccounts } from "./ports.js";
/** Renew immutable reviewed content under a current grant, without dispatching any remote operation. */
export class MySQLSocialContinuationService {
  constructor(
    private sources: AsyncSocialSources,
    private accounts: AsyncStore<SocialAccounts>,
    private store: (kind: unknown) => MySQLWorkflowRepository,
  ) {}
  async prepare(owner: string, input: Record<string, unknown>) {
    input = { ...input };
    if (
      Object.keys(input).some(
        (key) => !["id", "kind", "fingerprint", "stateToken", "successorId", "acceptContinuation"].includes(key),
      ) ||
      typeof input.id !== "string" ||
      typeof input.successorId !== "string" ||
      ![input.id, input.successorId].every((id) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) ||
      typeof input.stateToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.stateToken) ||
      typeof input.fingerprint !== "string" ||
      input.acceptContinuation !== true
    )
      throw new DeliveryError("invalidInput");
    const store = this.store(input.kind),
      parent = await store.owned(owner, input.id),
      original = socialPayload(parent.plan);
    if (parent.plan.fingerprint !== input.fingerprint) throw new DeliveryError("conflict", 409);
    const target = await mysqlCurrentBoundTarget(this.accounts, owner, original.target),
      payload = { ...original, target };
    const sourceGuard = await this.sources.authorize(
      owner,
      original.source,
      parent.plan.projectId,
      parent.plan.spaceId,
    );
    const authorize = async () => {
      await sourceGuard();
      await this.accounts.assert(owner, target, original.media?.length ? "media" : undefined);
    };
    return await store.lineage.create(
      owner,
      parent.plan.id,
      input.stateToken,
      {
        id: input.successorId,
        projectId: parent.plan.projectId,
        spaceId: parent.plan.spaceId,
        connectionId: parent.plan.connectionId,
        payload: payload as unknown as JsonValue,
        ...(parent.plan.sourceProjectId === undefined ? {} : { sourceProjectId: parent.plan.sourceProjectId }),
      },
      authorize,
    );
  }
}
