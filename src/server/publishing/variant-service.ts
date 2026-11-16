import { mapMetadata } from "../../shared/async-value.js";
import type { PublicationGuard } from "./content/source-port.js";
import type { MetadataStore, MetadataValue } from "../../shared/async-value.js";
import type { ChannelTemplateDescriptor } from "../../shared/presentation/templates.js";
import type { ContentIssue, ContentIR, PublicationFormat } from "../../shared/publishing/content.js";
import type { VariantDetail } from "../../shared/publishing/variants.js";
import type { PublicationSources } from "./content/source-port.js";
import type { VariantRepository } from "./variant-repository.js";
import type { VariantStore } from "./ports.js";
import { PublicationError } from "./errors.js";
import { parseContent } from "./content/parse.js";
import { transformContent } from "./variant-transform.js";
import type { ContentFormatter } from "./content/formatter.js";
import {
  builtinChannelTemplates,
  validateChannelTemplate,
  TemplateSelectionError,
  type ChannelTemplateCatalog,
} from "../../shared/presentation/templates.js";
import { applySuggestions, proofread } from "./content/proofread.js";
import { publicationField as field, publicationProject } from "./input.js";
import { variantContentDigest, type VariantContents } from "./variant-content.js";
import { stableJson } from "../../shared/stable-json.js";

export const issueKey = (issue: ContentIssue) => `${issue.blockId}:${issue.code}`;
/** Review is tied to immutable content; it never grants permission to publish externally. */
export class VariantService<
  R extends VariantStore = VariantRepository,
  C extends MetadataStore<ChannelTemplateCatalog> = ChannelTemplateCatalog,
> {
  constructor(
    readonly repository: R,
    private sources: PublicationSources,
    private formatters: ReadonlyMap<PublicationFormat, ContentFormatter>,
    private templateCatalog: C = builtinChannelTemplates as C,
    private contents?: VariantContents,
  ) {}
  templates(): MetadataValue<C, ChannelTemplateCatalog, ChannelTemplateDescriptor[]> {
    return this.templateCatalog.list() as MetadataValue<C, ChannelTemplateCatalog, ChannelTemplateDescriptor[]>;
  }
  async list(documentId: string, projectId?: string) {
    documentId = field(documentId);
    projectId = publicationProject(projectId);
    const guard = await this.sources.authorize(documentId, projectId);
    const values = await this.repository.list(documentId, projectId);
    await guard();
    return values;
  }
  /** One authorized immutable snapshot serves preview/export without loading its body twice. */
  async capture(id: string) {
    id = field(id);
    const reference = await this.repository.files.reference(id),
      inline = reference ? null : await this.repository.get(id),
      ref = reference ? reference.source : inline!.variant.source,
      guard = await this.sources.authorize(ref.documentId, ref.projectId);
    let detail: Omit<VariantDetail, "stale">, ir: ContentIR;
    if (reference) {
      if (!this.contents) throw new PublicationError("unavailable", 503);
      const content = await this.contents.read(reference.digest);
      if (
        content.variant.id !== id ||
        variantContentDigest(content) !== reference.digest ||
        stableJson(content.variant.source) !== stableJson(ref) ||
        content.ir.documentId !== ref.documentId ||
        content.ir.revisionId !== ref.revisionId ||
        content.ir.projectId !== ref.projectId ||
        content.ir.commit !== ref.commit ||
        content.ir.sourceHash !== ref.sourceHash
      )
        throw new PublicationError("unavailable", 503);
      detail = { variant: content.variant, digest: reference.digest, review: reference.review };
      ir = content.ir;
    } else {
      detail = inline!;
      ir = await this.repository.source(id);
    }
    const current = await this.sources.current(ref.documentId, ref.projectId);
    await guard();
    return { detail: { ...detail, stale: current.revisionId !== ref.revisionId }, ir, guard };
  }
  async detail(id: string): Promise<VariantDetail> {
    return (await this.capture(id)).detail;
  }
  async source(id: string) {
    return (await this.capture(id)).ir;
  }
  async prepare(input: Record<string, unknown>) {
    input = { ...input };
    if (
      Object.keys(input).some(
        (key) =>
          !["documentId", "revisionId", "projectId", "mode", "format", "templateId", "templateVersion"].includes(key),
      )
    )
      throw new PublicationError("invalidInput");
    const documentId = field(input.documentId),
      revisionId = field(input.revisionId),
      projectId = publicationProject(input.projectId);
    if (input.mode !== "format") throw new PublicationError("unsupportedMode");
    const format = field(input.format) as PublicationFormat,
      templateId = field(input.templateId);
    const formatter = this.formatters.get(format);
    if (!formatter) throw new PublicationError("invalidInput");
    let template;
    try {
      template = validateChannelTemplate(
        await this.templateCatalog.resolve(
          templateId,
          input.templateVersion === undefined ? undefined : field(input.templateVersion),
        ),
      );
      if (template.id !== templateId) throw new TemplateSelectionError("invalidTemplate");
      if (input.templateVersion !== undefined && template.version !== field(input.templateVersion))
        throw new TemplateSelectionError("staleTemplate");
    } catch (error) {
      if (error instanceof TemplateSelectionError)
        throw new PublicationError(error.code, error.code === "staleTemplate" ? 409 : 400);
      throw error;
    }
    if (!template.formats.includes(format)) throw new PublicationError("invalidInput");
    const guard = await this.sources.authorize(documentId, projectId);
    if ((await this.sources.current(documentId, projectId)).revisionId !== revisionId)
      throw new PublicationError("staleSource", 409);
    const source = await this.sources.revision(documentId, revisionId, projectId);
    if (source.documentId !== documentId || source.revisionId !== revisionId || source.projectId !== projectId)
      throw new PublicationError("unavailable", 503);
    const ir = parseContent(source),
      variant = transformContent(ir, format, template, formatter);
    if (projectId !== undefined) {
      if (!this.contents) throw new PublicationError("unavailable", 503);
      await guard();
      const digest = await this.contents.put({ variant, ir });
      if (digest !== variantContentDigest({ variant, ir })) throw new PublicationError("unavailable", 503);
    }
    if ((await this.sources.current(documentId, projectId)).revisionId !== revisionId)
      throw new PublicationError("staleSource", 409);
    return await this.write(guard, (writeGuard) => {
      if (projectId !== undefined)
        return mapMetadata(this.repository.files.register(variant, ir, writeGuard), () => ({
          variant,
          digest: variantContentDigest({ variant, ir }),
          review: null,
          stale: false,
        }));
      return mapMetadata(this.repository.create(variant, ir, writeGuard), (result) => ({ ...result, stale: false }));
    });
  }
  async review(id: string, input: Record<string, unknown>, reviewer: string): Promise<VariantDetail> {
    const expected = field(input.digest),
      reviewerId = field(reviewer, 200),
      accepted = Array.isArray(input.acceptedIssues) ? [...input.acceptedIssues] : null,
      { detail, guard } = await this.capture(id);
    if (detail.stale) throw new PublicationError("staleSource", 409);
    if (expected !== detail.digest) throw new PublicationError("staleVariant", 409);
    if (detail.variant.issues.some((issue) => issue.severity === "blocking"))
      throw new PublicationError("blockedContent", 409);
    if (!Array.isArray(accepted) || accepted.some((item) => typeof item !== "string"))
      throw new PublicationError("invalidInput");
    const required = detail.variant.issues.filter((issue) => issue.severity === "warning").map(issueKey);
    if (required.some((key) => !accepted.includes(key))) throw new PublicationError("reviewRequired", 409);
    const result = await this.write(guard, (writeGuard) =>
      this.repository.review(
        id,
        { digest: detail.digest, reviewer: reviewerId, reviewedAt: Date.now(), acceptedIssues: [...new Set(required)] },
        writeGuard,
      ),
    );
    return { ...detail, review: result, stale: false };
  }
  private write<T>(guard: PublicationGuard, commit: (guard: PublicationGuard) => T) {
    // Native writes recheck authority on their transaction; a SQLite mutation follows the resolved guard synchronously.
    return this.repository.asynchronous ? commit(guard) : mapMetadata(guard(), () => commit(() => {}));
  }
  async proofreading(documentId: string, revisionId: string, projectId?: string) {
    documentId = field(documentId);
    revisionId = field(revisionId);
    projectId = publicationProject(projectId);
    const guard = await this.sources.authorize(documentId, projectId);
    const result = proofread(parseContent(await this.sources.revision(documentId, revisionId, projectId)));
    await guard();
    return result;
  }
  async proofreadProposal(documentId: string, revisionId: string, selected: unknown, projectId?: string) {
    documentId = field(documentId);
    revisionId = field(revisionId);
    projectId = publicationProject(projectId);
    const guard = await this.sources.authorize(documentId, projectId);
    if ((await this.sources.current(documentId, projectId)).revisionId !== revisionId)
      throw new PublicationError("staleSource", 409);
    if (!Array.isArray(selected) || selected.length > 10_000 || selected.some((item) => typeof item !== "string"))
      throw new PublicationError("invalidInput");
    const selection = [...selected];
    const ir = parseContent(await this.sources.revision(documentId, revisionId, projectId));
    await guard();
    if (ir.origin?.kind === "richtext") throw new PublicationError("unsupportedMode");
    try {
      return {
        sourceRevision: revisionId,
        content: applySuggestions(ir, selection),
        title: ir.title,
        locale: ir.locale,
      };
    } catch {
      throw new PublicationError("invalidInput");
    }
  }
}
