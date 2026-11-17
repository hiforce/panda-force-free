import { createHash } from "node:crypto";
import { stableJson } from "../../../shared/stable-json.js";
import type { DocumentOwnershipScope } from "../../../shared/documents/ownership.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { DocumentError } from "../errors.js";
import { projectContentId } from "../../project-content/paths.js";
import { DocumentOwnershipMove } from "./move.js";
import { freezeOwnershipPlan, fileOwnershipInventory } from "./plan.js";
import { admittedOwnership, documentOwnershipRequest, ownershipRequestKey } from "./application-record.js";
import type {
  DocumentOwnershipApplicationOptions,
  DocumentOwnershipAccess,
  AdmittedDocumentOwnership,
} from "./application-contracts.js";

/** Admission is durable before either store changes; a lost acknowledgment resumes the frozen transfer, never a copy. */
export class DocumentOwnershipApplication {
  private readonly files: FilePackageContent<AdmittedDocumentOwnership>;
  constructor(private readonly options: DocumentOwnershipApplicationOptions) {
    this.files = new FilePackageContent(options.root, {
      maxBytes: 32 * 1024 * 1024,
      encode: async (value) => Buffer.from(stableJson(admittedOwnership(value))),
      decode: async (bytes) => admittedOwnership(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: (value) => ownershipRequestKey(value.request.owner, value.request.operationId),
    });
  }
  scope(owner: string, projectId: string): DocumentOwnershipScope {
    return projectId === "personal"
      ? { projectId, personalOwnerHash: createHash("sha256").update(owner).digest("hex") }
      : { projectId };
  }
  private async authorized(owner: string, scope: DocumentOwnershipScope, access: DocumentOwnershipAccess) {
    if (scope.projectId === "personal" && scope.personalOwnerHash !== this.scope(owner, "personal").personalOwnerHash)
      throw new DocumentError("notFound", 404);
    await this.options.authorize(owner, scope, access);
  }
  private async read(owner: string, id: string) {
    try {
      return await this.files.read(ownershipRequestKey(owner, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async authorizeDestination(owner: string, projectId: string) {
    await this.authorized(owner, this.scope(owner, projectContentId(projectId)), "contribute");
  }
  async request(owner: string, id: string) {
    const admitted = await this.read(owner, id);
    if (!admitted) return null;
    await this.authorized(owner, admitted.plan.from, "contribute");
    await this.authorized(owner, admitted.plan.to, "contribute");
    return structuredClone(admitted.request);
  }
  async prepare(value: unknown) {
    const request = documentOwnershipRequest(value),
      from = this.scope(request.owner, request.fromProjectId),
      to = this.scope(request.owner, request.toProjectId);
    await this.authorized(request.owner, from, "contribute");
    await this.authorized(request.owner, to, "contribute");
    const prior = await this.read(request.owner, request.operationId);
    if (prior) {
      if (stableJson(prior.request) !== stableJson(request)) throw new DocumentError("conflict", 409);
      await this.authorized(request.owner, from, "contribute");
      await this.authorized(request.owner, to, "contribute");
      return prior;
    }
    const backend = await this.options.backend(request.owner, from),
      source =
        backend.kind === "files"
          ? {
              kind: "files" as const,
              snapshot: await backend.source.capture(from.projectId, request.expected.documentId),
            }
          : {
              kind: "sql" as const,
              snapshot: await backend.source.capture(from.projectId, request.expected.documentId),
            },
      inventory = source.kind === "files" ? fileOwnershipInventory(source.snapshot) : source.snapshot.inventory,
      plan = freezeOwnershipPlan(request.owner, request.operationId, from, to, request.parentId, inventory),
      record = admittedOwnership({ schema: 1, request, plan, source });
    await this.authorized(request.owner, from, "contribute");
    await this.authorized(request.owner, to, "contribute");
    await this.files.put(record);
    const saved = await this.read(request.owner, request.operationId);
    if (!saved || stableJson(saved.request) !== stableJson(request)) throw new DocumentError("conflict", 409);
    return saved;
  }
  async execute(value: unknown) {
    const admitted = await this.prepare(value),
      { request, plan } = admitted,
      source = await this.options.backend(request.owner, plan.from),
      target = await this.options.backend(request.owner, plan.to),
      authorize = (owner: string, scope: DocumentOwnershipScope) => this.authorized(owner, scope, "contribute");
    if (source.kind === "files" && admitted.source.kind === "files")
      return new DocumentOwnershipMove(source.source, source.removal, target.target, authorize).execute(
        plan,
        admitted.source.snapshot,
      );
    if (source.kind === "sql" && admitted.source.kind === "sql")
      return new DocumentOwnershipMove(source.source, source.removal, target.target, authorize).execute(
        plan,
        admitted.source.snapshot,
      );
    throw new DocumentError("conflict", 409);
  }
  async locate(owner: string, projectId: string, documentId: string, access: DocumentOwnershipAccess = "read") {
    projectContentId(documentId);
    let scope = this.scope(owner, projectContentId(projectId)),
      lineage: string | undefined;
    const seen = new Set<string>();
    for (let depth = 0; depth < 64; depth++) {
      const key = stableJson(scope);
      if (seen.has(key)) throw new DocumentError("conflict", 409);
      seen.add(key);
      await this.authorized(owner, scope, access);
      const current = await this.options.location(owner, scope, documentId),
        record = current.ownership;
      await this.authorized(owner, scope, access);
      if (
        record &&
        (record.documentId !== documentId ||
          stableJson(record.kind === "outgoing" ? record.from : record.to) !== stableJson(scope))
      )
        throw new DocumentError("notFound", 404);
      if (record && lineage && record.lineageId !== lineage) throw new DocumentError("notFound", 404);
      if (current.active) {
        if (record && record.kind !== "active") throw new DocumentError("conflict", 409);
        if (lineage && !record) throw new DocumentError("notFound", 404);
        return { projectId: scope.projectId, documentId };
      }
      if (!record || record.kind === "active") throw new DocumentError("notFound", 404);
      if (record.kind === "incoming") throw new DocumentError("unavailable", 503);
      lineage = record.lineageId;
      scope = record.to;
    }
    throw new DocumentError("conflict", 409);
  }
}
