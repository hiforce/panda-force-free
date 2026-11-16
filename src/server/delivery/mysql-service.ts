import type { AwaitableStore } from "../../shared/async-store.js";
import type { SitePublicationPlan } from "../../shared/delivery/contracts.js";
import { DeliveryError } from "./errors.js";
import type { MySQLPublicationRepository } from "./mysql-repository.js";
import type { PublicationConnections, PublicationSources } from "./ports.js";
import { digest, publicationRequest, verifiedArtifact } from "./validation.js";
/** Preparation freezes content only. Publishing requires a separate, explicit command against that plan. */
export class MySQLPublicationService {
  private captures = 0;
  constructor(
    private sources: PublicationSources,
    private connections: AwaitableStore<PublicationConnections>,
    private store: MySQLPublicationRepository,
    private wake: () => void,
  ) {}
  async list(ownerId: string, spaceId: string, projectId?: string) {
    await (await this.sources.authorize(spaceId, projectId)).assertCurrent();
    return await this.store.list(ownerId, spaceId, projectId);
  }
  async detail(ownerId: string, id: string) {
    const record = await this.store.owned(ownerId, id);
    await (await this.sources.authorize(record.plan.spaceId, record.plan.sourceProjectId)).assertCurrent();
    return await this.store.owned(ownerId, id);
  }
  async prepare(ownerId: string, value: unknown) {
    const request = publicationRequest(value),
      previous = await this.store.existing(ownerId, request);
    if (previous) return await this.detail(ownerId, previous.plan.id);
    if (this.captures >= 2) throw new DeliveryError("busy", 429);
    this.captures++;
    try {
      const { connection, targetPath } = await this.connections.owned(ownerId, request.connectionId);
      await this.connections.assertReady(ownerId, request.connectionId);
      if (!connection.enabled || connection.version !== request.connectionVersion)
        throw new DeliveryError("connectionChanged", 409);
      const snapshot = await this.sources.capture(request.buildId, ownerId);
      if (connection.projectId !== snapshot.projectId || request.projectId !== snapshot.sourceProjectId)
        throw new DeliveryError("notFound", 404);
      if (connection.publicUrl !== snapshot.build.site.url + snapshot.build.site.basePath)
        throw new DeliveryError("siteUrlMismatch", 409);
      const artifact = verifiedArtifact(snapshot.artifact),
        now = Date.now();
      const fingerprint = digest(
        JSON.stringify({
          request,
          build: snapshot.build,
          ...(snapshot.sourceProjectId === undefined ? {} : { sourceProjectId: snapshot.sourceProjectId }),
          connection,
          files: artifact.files.map(({ path, sha256 }) => ({ path, sha256 })),
        }),
      );
      const plan: SitePublicationPlan = {
        ...request,
        projectId: snapshot.projectId,
        ...(snapshot.sourceProjectId === undefined ? {} : { sourceProjectId: snapshot.sourceProjectId }),
        spaceId: snapshot.spaceId,
        build: snapshot.build,
        connection,
        fingerprint,
        fileCount: artifact.files.length,
        outputBytes: artifact.bytes,
        servedPath: targetPath + "/current",
        createdAt: now,
        expiresAt: now + 86400000,
      };
      const assertCurrent = await this.assertExecutable(ownerId, plan);
      await this.store.expire();
      return await this.store.prepare(ownerId, request, plan, artifact, assertCurrent);
    } finally {
      this.captures--;
    }
  }
  async assertExecutable(ownerId: string, plan: SitePublicationPlan, checkOnly = false): Promise<() => Promise<void>> {
    const access = await this.sources.authorize(plan.spaceId, plan.sourceProjectId);
    const assertCurrent = async () => {
      await access.assertCurrent();
      const { connection, targetPath } = await this.connections.owned(ownerId, plan.connectionId);
      if (!checkOnly) await this.connections.assertReady(ownerId, plan.connectionId);
      if (
        (!checkOnly && (!connection.enabled || connection.version !== plan.connectionVersion)) ||
        connection.projectId !== plan.projectId ||
        (plan.sourceProjectId !== undefined && plan.sourceProjectId !== plan.projectId) ||
        targetPath + "/current" !== plan.servedPath
      )
        throw new DeliveryError("connectionChanged", 409);
      if (connection.connector === "local-site") await access.assertDestination(targetPath);
    };
    await assertCurrent();
    return assertCurrent;
  }
  async publish(ownerId: string, id: string, fingerprint: string) {
    const record = await this.store.owned(ownerId, id);
    if (record.plan.fingerprint !== fingerprint) throw new DeliveryError("conflict", 409);
    if (["queued", "running", "published"].includes(record.job.phase)) {
      const current = await this.detail(ownerId, id);
      this.wake();
      return current;
    }
    // Recheck source and connection ownership inside the native transaction.
    const assertCurrent = await this.assertExecutable(ownerId, record.plan);
    const result = await this.store.queue(ownerId, id, assertCurrent);
    this.wake();
    return result;
  }
  async cancel(ownerId: string, id: string) {
    const { plan } = await this.store.owned(ownerId, id),
      access = await this.sources.authorize(plan.spaceId, plan.sourceProjectId);
    return await this.store.cancel(ownerId, id, () => access.assertCurrent());
  }
  async reconcile(ownerId: string, id: string) {
    const record = await this.store.owned(ownerId, id),
      assertCurrent = await this.assertExecutable(ownerId, record.plan, true);
    const result = await this.store.reconcile(ownerId, id, assertCurrent);
    this.wake();
    return result;
  }
  async recover(ownerId: string, id: string, fingerprint: string) {
    const record = await this.store.owned(ownerId, id);
    if (record.plan.fingerprint !== fingerprint || record.plan.connection.connector !== "sftp-site")
      throw new DeliveryError("conflict", 409);
    const assertCurrent = await this.assertExecutable(ownerId, record.plan, true);
    const result = await this.store.reconcile(ownerId, id, assertCurrent, true);
    this.wake();
    return result;
  }
}
