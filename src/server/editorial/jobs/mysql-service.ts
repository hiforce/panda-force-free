import { randomUUID } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import { EditorialError } from "../errors.js";
import type { AsyncEditorialSources } from "../async-ports.js";
import type { EditorialModel } from "../model/contracts.js";
import type { MySQLEditorialJobRepository } from "./mysql-repository.js";
import { editorialValue as field, editorialUuid as uuid, editorialProject } from "../input.js";
/** Submission freezes source identity before queueing; file IO is never part of the queue transaction. */
export class MySQLEditorialJobs {
  constructor(
    private repository: MySQLEditorialJobRepository,
    private sources: AsyncEditorialSources,
    private models: ReadonlyMap<string, EditorialModel>,
    private now: () => number = Date.now,
  ) {}
  async submit(owner: string, input: Record<string, unknown>) {
    if (
      Object.keys(input).some(
        (key) => !["id", "documentId", "revisionId", "profileId", "mode", "projectId"].includes(key),
      )
    )
      throw new EditorialError("invalidInput");
    owner = field(owner, 200);
    const id = uuid(input.id),
      documentId = field(input.documentId),
      revisionId = field(input.revisionId),
      profileId = field(input.profileId),
      projectId = editorialProject(input.projectId),
      mode = input.mode;
    if (mode !== "proofread" && mode !== "rewrite") throw new EditorialError("unsupportedMode");
    const assertCurrent = await this.sources.authorize(documentId, projectId),
      request = stableJson({
        documentId,
        revisionId,
        profileId,
        mode,
        ...(projectId === undefined ? {} : { projectId }),
      });
    const existing = await this.repository.existing(owner, id, request);
    if (existing) {
      await assertCurrent();
      return existing.job;
    }
    const model = this.models.get(profileId);
    if (!model || model.profile.id !== profileId) throw new EditorialError("unavailable", 503);
    const source = await this.sources.revision(documentId, revisionId, projectId);
    if (stableJson(await this.sources.current(documentId, projectId)) !== stableJson(source.ref))
      throw new EditorialError("staleSource", 409);
    return await this.repository.transaction(async () => {
      await assertCurrent();
      const previous = await this.repository.existing(owner, id, request);
      if (previous) return previous.job;
      return (
        await this.repository.create(
          owner,
          request,
          {
            schema: 1,
            id,
            proposalId: randomUUID(),
            source: { ref: structuredClone(source.ref) },
            mode,
            profile: structuredClone(model.profile),
          },
          this.now(),
        )
      ).job;
    });
  }
  async detail(owner: string, id: string) {
    owner = field(owner, 200);
    id = field(id);
    const record = await this.repository.get(field(owner, 200), field(id)),
      ref = record.job.source,
      assertCurrent = await this.sources.authorize(ref.documentId, ref.projectId);
    await assertCurrent();
    return (await this.repository.get(owner, id)).job;
  }
  async list(owner: string, documentId: string, projectId?: string) {
    owner = field(owner, 200);
    documentId = field(documentId);
    projectId = editorialProject(projectId);
    const assertCurrent = await this.sources.authorize(documentId, projectId);
    await assertCurrent();
    return await this.repository.list(owner, documentId, projectId);
  }
  async cancel(owner: string, id: string) {
    owner = field(owner, 200);
    id = field(id);
    const record = await this.repository.get(field(owner, 200), field(id)),
      ref = record.job.source,
      assertCurrent = await this.sources.authorize(ref.documentId, ref.projectId);
    return await this.repository.transaction(async () => {
      await assertCurrent();
      return await this.repository.cancel(owner, id, this.now());
    });
  }
  async retry(owner: string, id: string, retryId: string) {
    owner = field(owner, 200);
    id = field(id);
    retryId = uuid(retryId);
    const { job } = await this.repository.get(owner, id),
      ref = job.source,
      assertCurrent = await this.sources.authorize(ref.documentId, ref.projectId);
    if (await this.repository.retried(owner, id, retryId)) {
      await assertCurrent();
      return (await this.repository.get(owner, id)).job;
    }
    const model = this.models.get(job.profile.id);
    if (!model || stableJson(model.profile) !== stableJson(job.profile)) throw new EditorialError("unavailable", 503);
    if (stableJson(await this.sources.current(ref.documentId, ref.projectId)) !== stableJson(ref))
      throw new EditorialError("staleSource", 409);
    return await this.repository.transaction(async () => {
      await assertCurrent();
      return await this.repository.retry(owner, id, retryId, this.now());
    });
  }
}
