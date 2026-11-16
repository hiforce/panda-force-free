import type { JsonValue } from "../../../shared/delivery/workflow.js";
import { currentBoundTarget } from "./target-binding.js";
import type { WorkflowRepository } from "../storage/workflows.js";
import type { SocialAccounts, SocialSources, SocialRecoveryReader } from "./ports.js";
import { socialPayload } from "./payload.js";
import { DeliveryError } from "../errors.js";

/** Recovery can inspect an expired snapshot; it never authorizes execution or changes its account binding. */
export class SocialRecoveryService {
  constructor(
    private sources: SocialSources,
    private accounts: SocialAccounts,
    private store: (kind: unknown) => WorkflowRepository,
    private client: SocialRecoveryReader,
  ) {}
  private async context(owner: string, input: Record<string, unknown>) {
    if (typeof input.id !== "string" || typeof input.fingerprint !== "string") throw new DeliveryError("invalidInput");
    const store = this.store(input.kind),
      record = store.owned(owner, input.id);
    if (record.plan.fingerprint !== input.fingerprint) throw new DeliveryError("conflict", 409);
    const payload = socialPayload(record.plan),
      target = currentBoundTarget(this.accounts, owner, payload.target);
    const sourceGuard = await this.sources.space(owner, record.plan.spaceId, record.plan.sourceProjectId);
    const authorize = () => {
      sourceGuard();
      this.accounts.assert(owner, target);
    };
    authorize();
    return { store, record, payload, target, authorize };
  }
  async inspect(owner: string, input: Record<string, unknown>) {
    input = { ...input };
    if (
      Object.keys(input).some(
        (key) => !["id", "kind", "fingerprint", "stepId", "remoteId", "acceptLookupCosts"].includes(key),
      ) ||
      !Number.isSafeInteger(input.stepId) ||
      typeof input.remoteId !== "string" ||
      !/^[0-9]{1,19}$/.test(input.remoteId) ||
      input.acceptLookupCosts !== true
    )
      throw new DeliveryError("invalidInput");
    const { store, record, target, authorize } = await this.context(owner, input),
      snapshot = store.recovery.capture(owner, record.plan.id, Number(input.stepId)),
      stepId = snapshot.step.id;
    this.client.validate(snapshot.record, stepId);
    const access = await this.accounts.access(owner, target);
    const report = await this.client.inspect(access, snapshot.record, stepId, input.remoteId);
    if (!report.details || typeof report.details !== "object" || Array.isArray(report.details))
      throw new DeliveryError("invalidReceipt", 409);
    report.details = { ...report.details, authorization: target as unknown as JsonValue };
    authorize();
    return store.recovery.record(owner, record.plan.id, snapshot.step.id, snapshot.stateToken, report, authorize);
  }
  async adopt(owner: string, input: Record<string, unknown>) {
    input = { ...input };
    if (
      Object.keys(input).some(
        (key) => !["id", "kind", "fingerprint", "evidenceId", "acceptExistingResult"].includes(key),
      ) ||
      typeof input.evidenceId !== "string" ||
      input.acceptExistingResult !== true
    )
      throw new DeliveryError("invalidInput");
    const { store, record, payload, target, authorize } = await this.context(owner, input);
    const evidence = record.recoveryEvidence.find((item) => item.id === input.evidenceId);
    if (!evidence) throw new DeliveryError("notFound", 404);
    const details = evidence.details,
      saved = details && typeof details === "object" && !Array.isArray(details) ? details.authorization : undefined;
    const binding = saved === undefined ? payload.target : saved;
    if (
      !binding ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      binding.id !== target.id ||
      binding.projectId !== target.projectId ||
      binding.accountId !== target.accountId ||
      binding.version !== target.version
    )
      throw new DeliveryError("recoveryAuthorizationChanged", 409);
    store.recovery.adopt(owner, record.plan.id, input.evidenceId, authorize);
    return store.owned(owner, record.plan.id);
  }
}
