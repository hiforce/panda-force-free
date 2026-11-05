import { errorPayload } from "../http/error-payload.js";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class ProjectError extends Error {
  constructor(status, messageId) {
    const payload = errorPayload(messageId);
    super(payload.error);
    this.messageId = messageId;
    this.status = status;
  }
}

export function projectFields(input) {
  if (!input || typeof input !== "object") throw new ProjectError(400, "projects.errorInvalidProjectDetails");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const code = typeof input.code === "string" ? input.code.trim().toLowerCase() : "";
  const description = input.description == null ? "" : input.description;
  if (!name || name.length > 100) throw new ProjectError(400, "projects.errorProjectNameMustContain1100Characters");
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(code))
    throw new ProjectError(400, "projects.errorProjectCodeMustContain264LettersNumbersHyphensOrUnderscores");
  if (typeof description !== "string" || description.length > 2000)
    throw new ProjectError(400, "projects.errorProjectDescriptionMustBe2000CharactersOrFewer");
  return { name, code, description: description.trim() };
}

/**
 * PandaForce metadata only: this store never owns native history or working folders.
 * Revision checks and writes share an immediate SQLite transaction, so competing
 * processes cannot silently overwrite a newer project assignment.
 */
export class ProjectCatalog {
  constructor(path) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 3000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO catalog_meta VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
        description TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_projects (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_projects_by_project ON session_projects(project_id);
    `);
  }
  revision() {
    return this.db.query("SELECT revision FROM catalog_meta WHERE id=1").get().revision;
  }
  project(id) {
    const result = this.db
      .query(
        "SELECT id, code, name, description, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id=?",
      )
      .get(id);
    if (!result) throw new ProjectError(404, "projects.errorProjectNotFound");
    return result;
  }
  snapshot() {
    return this.db.transaction(() => ({
      revision: this.revision(),
      projects: this.db
        .query(
          "SELECT id, code, name, description, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY created_at, id",
        )
        .all(),
      assignments: this.db
        .query(
          "SELECT session_id AS id, project_id AS projectId, name, cwd, updated_at AS updatedAt FROM session_projects",
        )
        .all(),
    }))();
  }
  mutate(revision, callback) {
    return this.db
      .transaction(() => {
        if (!Number.isSafeInteger(revision) || revision !== this.revision())
          throw new ProjectError(
            409,
            "projects.errorProjectsChangedInAnotherWindowReviewTheLatestInformationAndTryAgain",
          );
        callback();
        this.db.exec("UPDATE catalog_meta SET revision=revision+1 WHERE id=1");
        return this.snapshot();
      })
      .immediate();
  }
  save(input, revision) {
    const fields = projectFields(input);
    const id = input.id || randomUUID();
    return this.mutate(revision, () => {
      if (input.id) this.project(input.id);
      const duplicate = this.db
        .query("SELECT id FROM projects WHERE code=? COLLATE NOCASE AND id<>?")
        .get(fields.code, id);
      if (duplicate) throw new ProjectError(409, "projects.errorAProjectWithThisCodeAlreadyExists");
      const now = Date.now();
      this.db
        .query(
          `INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,description=excluded.description,updated_at=excluded.updated_at`,
        )
        .run(id, fields.code, fields.name, fields.description, now, now);
    });
  }
  assign(projectId, sessions, revision) {
    if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > 100)
      throw new ProjectError(400, "projects.errorSelectBetween1And100Sessions");
    const seen = new Set();
    for (const session of sessions) {
      if (typeof session?.id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(session.id) || seen.has(session.id))
        throw new ProjectError(400, "projects.errorInvalidSessionSelection");
      seen.add(session.id);
    }
    return this.mutate(revision, () => {
      if (projectId !== null) this.project(projectId);
      for (const session of sessions) {
        if (projectId === null) this.db.query("DELETE FROM session_projects WHERE session_id=?").run(session.id);
        else
          this.db
            .query(
              `INSERT INTO session_projects VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name,cwd=excluded.cwd,updated_at=excluded.updated_at`,
            )
            .run(
              session.id,
              projectId,
              String(session.name || session.preview || "").slice(0, 500),
              String(session.cwd || "").slice(0, 4096),
              Number.isFinite(session.updatedAt) ? Math.floor(session.updatedAt) : 0,
            );
      }
    });
  }
  refreshSessions(sessions) {
    const changes = [];
    for (const session of sessions || []) {
      if (!session?.id) continue;
      const current = this.db.query("SELECT name,cwd FROM session_projects WHERE session_id=?").get(session.id);
      if (!current) continue;
      const name = String(session.name || session.preview || current.name).slice(0, 500);
      const cwd = typeof session.cwd === "string" ? session.cwd.slice(0, 4096) : current.cwd;
      if (name !== current.name || cwd !== current.cwd) changes.push({ id: session.id, name, cwd });
    }
    if (!changes.length) return null;
    return this.db
      .transaction(() => {
        for (const s of changes)
          this.db.query("UPDATE session_projects SET name=?,cwd=? WHERE session_id=?").run(s.name, s.cwd, s.id);
        this.db.exec("UPDATE catalog_meta SET revision=revision+1 WHERE id=1");
        return this.snapshot();
      })
      .immediate();
  }
  forgetSession(id) {
    if (!this.db.query("SELECT 1 FROM session_projects WHERE session_id=?").get(id)) return null;
    return this.db
      .transaction(() => {
        this.db.query("DELETE FROM session_projects WHERE session_id=?").run(id);
        this.db.exec("UPDATE catalog_meta SET revision=revision+1 WHERE id=1");
        return this.snapshot();
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
