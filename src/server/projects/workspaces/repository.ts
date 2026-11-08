import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProductProject } from "../../../shared/data-contracts.js";

export interface ProjectWorkspaceBinding {
  projectId: string;
  code: string;
  root: string;
  path: string;
  ownerId: string;
  state: "preparing" | "ready";
}

/** Project metadata owns bindings and creation receipts, never document bodies or native history. */
export function migrateProjectWorkspaces(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS project_workspaces (
    projectId TEXT PRIMARY KEY REFERENCES projects(id),code TEXT NOT NULL,root TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,ownerId TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('preparing','ready'))
  );
  CREATE TABLE IF NOT EXISTS project_workspace_creations (
    operationId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id)
  );`);
}
export function workspaceSummaries(db: Database) {
  return new Map(
    db
      .query<{ projectId: string; path: string; state: ProjectWorkspaceBinding["state"] }, []>(
        "SELECT projectId,path,state FROM project_workspaces",
      )
      .all()
      .map(({ projectId, ...workspace }) => [projectId, workspace]),
  );
}
export function workspaceSummary(db: Database, projectId: string) {
  return db
    .query<{ path: string; state: ProjectWorkspaceBinding["state"] }, [string]>(
      "SELECT path,state FROM project_workspaces WHERE projectId=?",
    )
    .get(projectId);
}
export class ProjectWorkspaceRepository {
  constructor(private readonly db: Database) {}
  get(projectId: string): ProjectWorkspaceBinding | null {
    return this.db
      .query<ProjectWorkspaceBinding, [string]>("SELECT * FROM project_workspaces WHERE projectId=?")
      .get(projectId);
  }
  reserve(project: ProductProject, root: string): ProjectWorkspaceBinding {
    const existing = this.get(project.id);
    if (existing) return existing;
    const value: ProjectWorkspaceBinding = {
      projectId: project.id,
      code: project.code,
      root,
      path: join(root, project.code),
      ownerId: randomUUID(),
      state: "preparing",
    };
    this.db
      .query("INSERT INTO project_workspaces VALUES(?,?,?,?,?,?)")
      .run(value.projectId, value.code, value.root, value.path, value.ownerId, value.state);
    return value;
  }
  operation(id: string) {
    return this.db
      .query<{ requestHash: string; projectId: string }, [string]>(
        "SELECT requestHash,projectId FROM project_workspace_creations WHERE operationId=?",
      )
      .get(id);
  }
  recordOperation(operationId: string, requestHash: string, projectId: string): void {
    this.db.query("INSERT INTO project_workspace_creations VALUES(?,?,?)").run(operationId, requestHash, projectId);
  }
  ready(projectId: string): void {
    this.db
      .transaction(() => {
        if (
          this.db
            .query("UPDATE project_workspaces SET state='ready' WHERE projectId=? AND state='preparing'")
            .run(projectId).changes
        )
          this.db.exec("UPDATE catalog_meta SET revision=revision+1 WHERE id=1");
      })
      .immediate();
  }
}
