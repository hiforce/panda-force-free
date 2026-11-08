import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ProjectError, projectFields } from "../catalog.js";
import type { ProductProject } from "../../../shared/data-contracts.js";
import type { ProjectSnapshot } from "../../../shared/engine/types.js";
import { ProjectWorkspaceDirectory } from "./directory.js";
import { ProjectWorkspaceRepository, type ProjectWorkspaceBinding } from "./repository.js";

export interface WorkspaceCatalog {
  readonly db: Database;
  project(id: string): ProductProject;
  save(input: unknown, revision: unknown): ProjectSnapshot;
  snapshot(): ProjectSnapshot;
  atomic<T>(work: () => T): T;
}
/** Coordinates durable metadata reservations with filesystem preparation; never moves historical workspaces. */
export class ProjectWorkspaceService {
  private readonly repository: ProjectWorkspaceRepository;
  private readonly directory: ProjectWorkspaceDirectory;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(
    private readonly catalog: WorkspaceCatalog,
    readonly root: string,
    private readonly available = true,
  ) {
    this.repository = new ProjectWorkspaceRepository(catalog.db);
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
    this.repository.ready(binding.projectId);
    return { path: binding.path, state: "ready" as const };
  }
  async create(input: unknown, revision: unknown, requestId?: unknown): Promise<ProjectSnapshot> {
    const fields = projectFields(input),
      operationId = requestId ?? randomUUID();
    if (typeof operationId !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(operationId))
      throw new ProjectError(400, "projects.errorInvalidProjectDetails");
    const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    return this.exclusive(async () => {
      if (!this.repository.operation(operationId)) {
        if (this.catalog.snapshot().projects.some((project) => project.code === fields.code))
          throw new ProjectError(409, "projects.errorAProjectWithThisCodeAlreadyExists");
        await this.directory.assertAvailable(fields.code);
      }
      const binding = this.catalog.atomic(() => {
        const previous = this.repository.operation(operationId);
        if (previous) {
          if (previous.requestHash !== hash) throw new ProjectError(409, "projects.errorWorkspaceRequestChanged");
          const current = this.repository.get(previous.projectId);
          if (!current) throw new ProjectError(409, "projects.errorWorkspaceConflict");
          return current;
        }
        const snapshot = this.catalog.save(fields, revision),
          project = snapshot.projects.find((project) => project.code === fields.code);
        if (!project) throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
        const reserved = this.repository.reserve(project, this.root);
        this.repository.recordOperation(operationId, hash, project.id);
        return reserved;
      });
      await this.prepare(binding);
      return this.catalog.snapshot();
    });
  }
  async ensure(projectId: string) {
    return this.exclusive(async () => {
      if (!this.repository.get(projectId)) await this.directory.assertAvailable(this.catalog.project(projectId).code);
      const binding = this.catalog.atomic(() => this.repository.reserve(this.catalog.project(projectId), this.root));
      return this.prepare(binding);
    });
  }
}
