import { ContentAccessError } from "../content-access/contracts.js";
import type { SQL } from "bun";
import { validSessionReference } from "../../shared/engine/session-reference.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import type { ProductProject } from "../../shared/data-contracts.js";
import type { ProjectSnapshot } from "../../shared/engine/types.js";
import { ProjectError, projectFields } from "./catalog.js";
import { mysqlInteger } from "../database/mysql-model.js";
import { consistentMySQLRead } from "../database/consistent-read.js";
import type { ProjectWorkspaceBinding } from "./workspaces/repository.js";
import type { ProjectWorkspaceMetadata } from "./workspaces/metadata.js";

type Row = Record<string, unknown>;
export const projectPathHash = (path: string) => createHash("sha256").update(path).digest("hex");
const projectProjection = `SELECT p.id,p.code,p.name,p.description,p.created_at createdAt,p.updated_at updatedAt,w.path,w.state FROM panda_force_projects p LEFT JOIN panda_force_project_workspaces w ON w.projectId=p.id`;
function projectRow(row: Row): ProductProject {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: String(row.description),
    createdAt: mysqlInteger(row.createdAt),
    updatedAt: mysqlInteger(row.updatedAt),
    ...(row.path === null ? {} : { workspace: { path: String(row.path), state: row.state as "preparing" | "ready" } }),
  };
}

/** Nested metadata operations share one native MySQL transaction; filesystem preparation runs after commit. */
export class MySQLProjectCatalog {
  private readonly context = new AsyncLocalStorage<SQL>();
  constructor(private readonly pool: SQL) {}
  get sql() {
    return this.context.getStore() ?? this.pool;
  }
  get inTransaction() {
    return !!this.context.getStore();
  }
  private async protect<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProjectError || error instanceof ContentAccessError) throw error;
      const failure = new ProjectError(503, "projects.errorWorkspaceUnavailable");
      failure.cause = error;
      throw failure;
    }
  }
  async atomic<T>(work: () => Promise<T>): Promise<T> {
    if (this.inTransaction) return work();
    return this.protect(() =>
      this.pool.begin(async (tx) =>
        this.context.run(tx, async () => {
          await tx`INSERT INTO panda_force_catalog_meta(id,revision) VALUES(1,0) ON DUPLICATE KEY UPDATE id=VALUES(id)`;
          return work();
        }),
      ),
    );
  }
  async view<T>(work: () => Promise<T>): Promise<T> {
    if (this.inTransaction) return work();
    return this.protect(() => consistentMySQLRead(this.pool, async (tx) => this.context.run(tx, work)));
  }
  async revision(): Promise<number> {
    const rows = await this.sql`SELECT revision FROM panda_force_catalog_meta WHERE id=1`;
    return rows[0] ? mysqlInteger(rows[0].revision) : 0;
  }
  async project(id: string): Promise<ProductProject> {
    return this.protect(async () => {
      const rows = await this.sql.unsafe(projectProjection + " WHERE p.id=?", [id]);
      if (!rows[0]) throw new ProjectError(404, "projects.errorProjectNotFound");
      return projectRow(rows[0]);
    });
  }
  async snapshot(): Promise<ProjectSnapshot> {
    return this.view(async () => ({
      revision: await this.revision(),
      projects: (await this.sql.unsafe(projectProjection + " ORDER BY p.created_at,p.id")).map(projectRow),
      assignments: (
        await this
          .sql`SELECT session_id id,project_id projectId,name,cwd,updated_at updatedAt FROM panda_force_session_projects`
      ).map((r: Row) => ({
        id: String(r.id),
        projectId: String(r.projectId),
        name: String(r.name),
        cwd: String(r.cwd),
        updatedAt: mysqlInteger(r.updatedAt),
      })),
    }));
  }
  private async mutate(revision: unknown, work: () => Promise<void>) {
    return this.atomic(async () => {
      if (!Number.isSafeInteger(revision) || revision !== (await this.revision()))
        throw new ProjectError(
          409,
          "projects.errorProjectsChangedInAnotherWindowReviewTheLatestInformationAndTryAgain",
        );
      await work();
      await this.sql`UPDATE panda_force_catalog_meta SET revision=revision+1 WHERE id=1`;
      return this.snapshot();
    });
  }
  async save(input: unknown, revision: unknown): Promise<ProjectSnapshot> {
    const fields = projectFields(input);
    const requested = (input as { id?: unknown }).id;
    if (requested !== undefined && (typeof requested !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(requested)))
      throw new ProjectError(400, "projects.errorInvalidProjectDetails");
    const id = typeof requested === "string" ? requested : randomUUID();
    return this.mutate(revision, async () => {
      if (requested) {
        const previous = await this.project(id);
        if (previous.workspace && previous.code !== fields.code)
          throw new ProjectError(409, "projects.errorWorkspaceCodeImmutable");
      }
      if ((await this.sql`SELECT id FROM panda_force_projects WHERE code=${fields.code} AND id<>${id}`).length)
        throw new ProjectError(409, "projects.errorAProjectWithThisCodeAlreadyExists");
      const now = Date.now();
      if (requested)
        await this
          .sql`UPDATE panda_force_projects SET code=${fields.code},name=${fields.name},description=${fields.description},updated_at=${now} WHERE id=${id}`;
      else
        await this
          .sql`INSERT INTO panda_force_projects(id,code,name,description,created_at,updated_at) VALUES(${id},${fields.code},${fields.name},${fields.description},${now},${now})`;
    });
  }
  async assign(
    projectId: string | null,
    sessions: readonly { id: string; name?: string; preview?: string; cwd?: string; updatedAt?: number }[],
    revision: unknown,
  ) {
    if (
      !Array.isArray(sessions) ||
      !sessions.length ||
      sessions.length > 100 ||
      sessions.some((s) => !validSessionReference(s?.id)) ||
      new Set(sessions.map((s) => s.id)).size !== sessions.length
    )
      throw new ProjectError(400, "projects.errorInvalidSessionSelection");
    return this.mutate(revision, async () => {
      if (projectId !== null) await this.project(projectId);
      if (projectId === null)
        await this.sql.unsafe(
          `DELETE FROM panda_force_session_projects WHERE session_id IN (${sessions.map(() => "?").join(",")})`,
          sessions.map((session) => session.id),
        );
      else
        await this.sql.unsafe(
          `INSERT INTO panda_force_session_projects(session_id,project_id,name,cwd,updated_at) VALUES ${sessions.map(() => "(?,?,?,?,?)").join(",")} ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),name=VALUES(name),cwd=VALUES(cwd),updated_at=VALUES(updated_at)`,
          sessions.flatMap((s) => [
            s.id,
            projectId,
            String(s.name || s.preview || "").slice(0, 500),
            String(s.cwd || "").slice(0, 4096),
            Number.isFinite(s.updatedAt) ? Math.floor(s.updatedAt!) : 0,
          ]),
        );
    });
  }
  async refreshSessions(sessions: readonly { id: string; name?: string; preview?: string; cwd?: string }[]) {
    return this.atomic(async () => {
      let changed = false;
      const valid = (sessions || []).filter((session) => session?.id);
      for (let offset = 0; offset < valid.length; offset += 128) {
        const batch = valid.slice(offset, offset + 128),
          ids = [...new Set(batch.map((session) => session.id))];
        const rows = await this.sql.unsafe(
          `SELECT session_id,name,cwd FROM panda_force_session_projects WHERE session_id IN (${ids.map(() => "?").join(",")})`,
          ids,
        );
        const existing = new Map<string, Row>(rows.map((row: Row) => [String(row.session_id), row])),
          updates = new Map<string, { name: string; cwd: string }>();
        for (const s of batch) {
          const row = existing.get(s.id);
          if (!row) continue;
          const name = String(s.name || s.preview || row.name).slice(0, 500),
            cwd = typeof s.cwd === "string" ? s.cwd.slice(0, 4096) : String(row.cwd);
          if (name === row.name && cwd === row.cwd) continue;
          updates.set(s.id, { name, cwd });
          row.name = name;
          row.cwd = cwd;
        }
        if (!updates.size) continue;
        const values = [...updates];
        await this.sql.unsafe(
          `UPDATE panda_force_session_projects SET name=CASE session_id ${values.map(() => "WHEN ? THEN ?").join(" ")} ELSE name END,cwd=CASE session_id ${values.map(() => "WHEN ? THEN ?").join(" ")} ELSE cwd END WHERE session_id IN (${values.map(() => "?").join(",")})`,
          [
            ...values.flatMap(([id, value]) => [id, value.name]),
            ...values.flatMap(([id, value]) => [id, value.cwd]),
            ...values.map(([id]) => id),
          ],
        );
        changed = true;
      }
      if (!changed) return null;
      await this.sql`UPDATE panda_force_catalog_meta SET revision=revision+1 WHERE id=1`;
      return this.snapshot();
    });
  }
  async forgetSession(id: string) {
    return this.atomic(async () => {
      if (!(await this.sql`SELECT session_id FROM panda_force_session_projects WHERE session_id=${id}`).length)
        return null;
      await this.sql`DELETE FROM panda_force_session_projects WHERE session_id=${id}`;
      await this.sql`UPDATE panda_force_catalog_meta SET revision=revision+1 WHERE id=1`;
      return this.snapshot();
    });
  }
  async files(projectId: string): Promise<boolean> {
    return !!(
      await this
        .sql`SELECT project_id FROM panda_force_project_document_storage WHERE project_id=${projectId} AND storage='files'`
    ).length;
  }
  async bindFiles(projectId: string): Promise<void> {
    await this.project(projectId);
    await this
      .sql`INSERT INTO panda_force_project_document_storage(project_id,storage,created_at) VALUES(${projectId},'files',${Date.now()}) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id)`;
  }
  private async binding(projectId: string): Promise<ProjectWorkspaceBinding | null> {
    const r = (
      await this
        .sql`SELECT projectId,code,root,path,ownerId,state FROM panda_force_project_workspaces WHERE projectId=${projectId}`
    )[0];
    return r
      ? { projectId: r.projectId, code: r.code, root: r.root, path: r.path, ownerId: r.ownerId, state: r.state }
      : null;
  }
  private async reserve(project: ProductProject, root: string): Promise<ProjectWorkspaceBinding> {
    const current = await this.binding(project.id);
    if (current) return current;
    const b: ProjectWorkspaceBinding = {
      projectId: project.id,
      code: project.code,
      root,
      path: join(root, project.code),
      ownerId: randomUUID(),
      state: "preparing",
    };
    await this
      .sql`INSERT INTO panda_force_project_workspaces(projectId,code,root,path,pathHash,ownerId,state) VALUES(${b.projectId},${b.code},${b.root},${b.path},${projectPathHash(b.path)},${b.ownerId},${b.state})`;
    return b;
  }
  readonly workspaceMetadata: ProjectWorkspaceMetadata = {
    get: (id) => this.protect(() => this.binding(id)),
    operation: (id) =>
      this.protect(async () => {
        const r = (
          await this
            .sql`SELECT requestHash,projectId FROM panda_force_project_workspace_creations WHERE operationId=${id}`
        )[0];
        return r ? { requestHash: String(r.requestHash), projectId: String(r.projectId) } : null;
      }),
    ready: (id) =>
      this.atomic(async () => {
        const current = await this.binding(id);
        if (current?.state !== "preparing") return;
        await this.sql`UPDATE panda_force_project_workspaces SET state='ready' WHERE projectId=${id}`;
        await this.sql`UPDATE panda_force_catalog_meta SET revision=revision+1 WHERE id=1`;
      }),
    ensure: (id, root) => this.atomic(async () => this.reserve(await this.project(id), root)),
    create: (input) =>
      this.atomic(async () => {
        const previous = await this.workspaceMetadata.operation(input.operationId);
        if (previous) {
          if (previous.requestHash !== input.requestHash)
            throw new ProjectError(409, "projects.errorWorkspaceRequestChanged");
          const current = await this.binding(previous.projectId);
          if (!current) throw new ProjectError(409, "projects.errorWorkspaceConflict");
          return current;
        }
        const fields = projectFields(input.fields),
          snapshot = await this.save(fields, input.revision);
        const project = snapshot.projects.find((p) => p.code === fields.code);
        if (!project) throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
        const binding = await this.reserve(project, input.root);
        await this
          .sql`INSERT INTO panda_force_project_workspace_creations(operationId,requestHash,projectId) VALUES(${input.operationId},${input.requestHash},${project.id})`;
        if ((await input.reserve?.(project, input.creator, input.members)) !== undefined)
          throw new ProjectError(503, "projects.errorWorkspaceUnavailable");
        return binding;
      }),
  };
  close() {}
}
