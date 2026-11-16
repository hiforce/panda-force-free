import type {
  EditorialDetail,
  EditorialMode,
  EditorialProposal,
  EditorialSourceRef,
} from "../../shared/editorial/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import type { EditorialProcessor, AsyncEditorialSources } from "./async-ports.js";
import type { MySQLEditorialRepository } from "./mysql-repository.js";
import { EditorialError } from "./errors.js";
import { editorialProject, editorialValue, editorialUuid } from "./input.js";
import { editorialBody } from "./patch.js";
import { MySQLEditorialApplications } from "./mysql-applications.js";
/** Review coordination never places file IO inside task transactions or runs a publication as a side effect. */
export class MySQLEditorialService {
  private applications: MySQLEditorialApplications;
  constructor(
    private repository: MySQLEditorialRepository,
    private sources: AsyncEditorialSources,
    private processors: ReadonlyMap<EditorialMode, EditorialProcessor>,
  ) {
    this.applications = new MySQLEditorialApplications(repository, sources);
  }
  private async view(owner: string, id: string, current: EditorialSourceRef): Promise<EditorialDetail> {
    const { proposal, digest, receipt } = await this.repository.get(owner, id),
      intent = receipt ? null : await this.repository.intent(owner, id);
    return {
      proposal,
      digest,
      receipt,
      stale: stableJson(current) !== stableJson(proposal.source),
      ...(intent ? { pending: { selected: intent.selected, appliedAt: intent.appliedAt } } : {}),
    };
  }
  async detail(owner: string, id: string): Promise<EditorialDetail> {
    owner = editorialValue(owner, 200);
    id = editorialValue(id);
    const stored = await this.repository.get(owner, id),
      source = stored.proposal.source,
      assertCurrent = await this.sources.authorize(source.documentId, source.projectId);
    await this.applications.recover(owner, stored, assertCurrent);
    const current = await this.sources.current(source.documentId, source.projectId);
    await assertCurrent();
    return await this.view(owner, id, current);
  }
  async list(owner: string, documentId: string, projectId?: string) {
    owner = editorialValue(owner, 200);
    documentId = editorialValue(documentId);
    projectId = editorialProject(projectId);
    const current = await this.sources.current(documentId, projectId);
    return await Promise.all(
      (await this.repository.list(owner, documentId, projectId)).map(async (id) => await this.view(owner, id, current)),
    );
  }
  async history(owner: string, documentId: string, before: string | null = null, projectId?: string) {
    owner = editorialValue(owner, 200);
    documentId = editorialValue(documentId);
    projectId = editorialProject(projectId);
    const current = await this.sources.current(documentId, projectId),
      page = await this.repository.historyPage(owner, documentId, before, projectId);
    return {
      reviews: page.reviews.map((review) => ({ ...review, stale: stableJson(review.source) !== stableJson(current) })),
      nextCursor: page.nextCursor,
    };
  }
  async prepare(owner: string, input: Record<string, unknown>): Promise<EditorialDetail> {
    owner = editorialValue(owner, 200);
    if (Object.keys(input).some((key) => !["id", "documentId", "revisionId", "mode", "projectId"].includes(key)))
      throw new EditorialError("invalidInput");
    const id = editorialUuid(input.id),
      documentId = editorialValue(input.documentId),
      revisionId = editorialValue(input.revisionId),
      projectId = editorialProject(input.projectId),
      mode = editorialValue(input.mode) as EditorialMode,
      processor = this.processors.get(mode);
    if (!processor) throw new EditorialError("unsupportedMode");
    await this.sources.current(documentId, projectId);
    const request = stableJson({ documentId, revisionId, mode, ...(projectId === undefined ? {} : { projectId }) });
    if (await this.repository.existing(owner, id, request)) return await this.detail(owner, id);
    const source = await this.sources.revision(documentId, revisionId, projectId);
    if (stableJson(await this.sources.current(documentId, projectId)) !== stableJson(source.ref))
      throw new EditorialError("staleSource", 409);
    const result = processor.prepare(source);
    return (
      await this.stagePrepared(owner, request, {
        schema: 1,
        id,
        source: source.ref,
        mode,
        ...result,
        createdAt: Date.now(),
      })
    )();
  }
  /** Async verification produces a metadata-only commit for the worker's current lease transaction. */
  async stagePrepared(
    owner: string,
    request: string,
    proposal: EditorialProposal,
  ): Promise<() => Promise<EditorialDetail>> {
    owner = editorialValue(owner, 200);
    const ref = proposal.source,
      assertCurrent = await this.sources.authorize(ref.documentId, ref.projectId),
      source = await this.sources.revision(ref.documentId, ref.revisionId, ref.projectId),
      current = await this.sources.current(ref.documentId, ref.projectId);
    if (stableJson(source.ref) !== stableJson(ref)) throw new EditorialError("staleSource", 409);
    if (proposal.edits.length) editorialBody(source.body, proposal.edits);
    return async () =>
      await this.repository.transaction(async () => {
        await assertCurrent();
        if (!(await this.repository.existing(owner, proposal.id, request)))
          await this.repository.create(owner, request, proposal);
        return await this.view(owner, proposal.id, current);
      });
  }
  async recordPrepared(owner: string, request: string, proposal: EditorialProposal): Promise<EditorialDetail> {
    return (await this.stagePrepared(owner, request, proposal))();
  }
  async accept(owner: string, input: Record<string, unknown>) {
    return await this.applications.accept(owner, input);
  }
}
