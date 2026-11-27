import { randomUUID } from "node:crypto";
import { ProjectError, projectFields } from "../catalog.js";
import type { ProjectSnapshot } from "../../../shared/engine/types.js";
import { projectCreationHash } from "../../content-access/storage/creation-receipt.js";
import { ProjectWorkspaceDirectory } from "./directory.js";
import type { ProjectWorkspaceBinding } from "./repository.js";
import {
  sqliteWorkspaceMetadata,
  type WorkspaceCatalog,
  type ProjectMetadataReservation,
  type AsyncProjectMetadataReservation,
  type ProjectWorkspaceMetadata,
} from "./metadata.js";
export type { WorkspaceCatalog, ProjectMetadataReservation } from "./metadata.js";
/** Coordinates durable metadata reservations with filesystem preparation; never moves historical workspaces. */
export class ProjectWorkspaceService<C extends WorkspaceCatalog = WorkspaceCatalog> {
  private readonly repository: ProjectWorkspaceMetadata;
  private readonly directory: ProjectWorkspaceDirectory;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(
    private readonly catalog: C,
    readonly root: string,
    private readonly available = true,
    private readonly reserveMetadata?: C extends { readonly workspaceMetadata: ProjectWorkspaceMetadata }
      ? AsyncProjectMetadataReservation
      : ProjectMetadataReservation,
  ) {
    if (catalog.workspaceMetadata) this.repository = catalog.workspaceMetadata;
    else {
      if (!catalog.db || !("save" in catalog) || !("atomic" in catalog))
        throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
      this.repository = sqliteWorkspaceMetadata(catalog as Parameters<typeof sqliteWorkspaceMetadata>[0]);
    }
    this.directory = new ProjectWorkspaceDirectory(root);
  }
  async initialize(): Promise<void> {
    if (!this.available) throw new ProjectError(503, "projects.errorWorkspaceSharedRootRequired");
    await this.directory.initialize();
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (!this.available) throw new ProjectError(503, "projects.errorWorkspaceSharedRootRequired");
    if (this.pending >= 64) throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
    this.pending++;
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => {});
    try {
      return await result;
    } finally {
      this.pending--;
    }
  }
  private async prepare(binding: ProjectWorkspaceBinding) {
    try {
      await this.directory.prepare(binding);
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
    }
    await this.repository.ready(binding.projectId);
    return { path: binding.path, state: "ready" as const };
  }
  async create(
    input: unknown,
    revision: unknown,
    requestId?: unknown,
    creator?: string,
    members: readonly string[] = [],
  ): Promise<ProjectSnapshot> {
    const fields = projectFields(input),
      operationId = requestId ?? randomUUID();
    if (typeof operationId !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(operationId))
      throw new ProjectError(400, "projects.errorInvalidProjectDetails");
    const hash = projectCreationHash(fields, creator, members);
    return this.exclusive(async () => {
      if (!(await this.repository.operation(operationId))) {
        if ((await this.catalog.snapshot()).projects.some((project) => project.code === fields.code))
          throw new ProjectError(409, "projects.errorAProjectWithThisCodeAlreadyExists");
        await this.directory.assertAvailable(fields.code);
      }
      const binding = await this.repository.create({
        fields,
        revision,
        operationId,
        requestHash: hash,
        root: this.root,
        creator,
        members,
        reserve: this.reserveMetadata,
      });
      await this.prepare(binding);
      return this.catalog.snapshot();
    });
  }
  async ensure(projectId: string) {
    return this.exclusive(async () => {
      if (!(await this.repository.get(projectId)))
        await this.directory.assertAvailable((await this.catalog.project(projectId)).code);
      const binding = await this.repository.ensure(projectId, this.root);
      return this.prepare(binding);
    });
  }
}
