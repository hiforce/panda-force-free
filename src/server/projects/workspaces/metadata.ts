import type { Database } from "bun:sqlite";
import type { ProductProject } from "../../../shared/data-contracts.js";
import type { ProjectSnapshot } from "../../../shared/engine/types.js";
import { ProjectError } from "../catalog.js";
import { ProjectWorkspaceRepository, type ProjectWorkspaceBinding } from "./repository.js";

type Awaitable<T> = T | Promise<T>;
export type ProjectMetadataReservation = (
  project: ProductProject,
  creator?: string,
  members?: readonly string[],
) => undefined;
export type AsyncProjectMetadataReservation = (
  project: ProductProject,
  creator?: string,
  members?: readonly string[],
) => Awaitable<undefined>;
export interface ProjectWorkspaceMetadata {
  get(project: string): Awaitable<ProjectWorkspaceBinding | null>;
  operation(id: string): Awaitable<{ requestHash: string; projectId: string } | null>;
  ready(project: string): Awaitable<void>;
  ensure(project: string, root: string): Awaitable<ProjectWorkspaceBinding>;
  create(input: {
    fields: unknown;
    revision: unknown;
    operationId: string;
    requestHash: string;
    root: string;
    creator?: string;
    members?: readonly string[];
    reserve?: AsyncProjectMetadataReservation;
  }): Awaitable<ProjectWorkspaceBinding>;
}
export interface WorkspaceCatalog {
  readonly db?: Database;
  readonly workspaceMetadata?: ProjectWorkspaceMetadata;
  project(id: string): Awaitable<ProductProject>;
  snapshot(): Awaitable<ProjectSnapshot>;
}
interface SQLiteWorkspaceCatalog {
  readonly db: Database;
  project(id: string): ProductProject;
  save(input: unknown, revision: unknown): ProjectSnapshot;
  atomic<T>(work: () => T): T;
}

/** SQLite reservations remain synchronous so their transaction never crosses an await boundary. */
export function sqliteWorkspaceMetadata(catalog: SQLiteWorkspaceCatalog): ProjectWorkspaceMetadata {
  const repository = new ProjectWorkspaceRepository(catalog.db);
  return {
    get: (id) => repository.get(id),
    operation: (id) => repository.operation(id),
    ready: (id) => repository.ready(id),
    ensure: (id, root) => catalog.atomic(() => repository.reserve(catalog.project(id), root)),
    create: (input) =>
      catalog.atomic(() => {
        const previous = repository.operation(input.operationId);
        if (previous) {
          if (previous.requestHash !== input.requestHash)
            throw new ProjectError(409, "projects.errorWorkspaceRequestChanged");
          const binding = repository.get(previous.projectId);
          if (!binding) throw new ProjectError(409, "projects.errorWorkspaceConflict");
          return binding;
        }
        const snapshot = catalog.save(input.fields, input.revision);
        const code = (input.fields as { code: string }).code;
        const project = snapshot.projects.find((p) => p.code === code);
        if (!project) throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
        const binding = repository.reserve(project, input.root);
        repository.recordOperation(input.operationId, input.requestHash, project.id);
        try {
          if (input.reserve?.(project, input.creator, input.members) !== undefined)
            throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
        } catch (error) {
          if (error instanceof ProjectError) throw error;
          throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
        }
        return binding;
      }),
  };
}
