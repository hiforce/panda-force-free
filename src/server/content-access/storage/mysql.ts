import { ContentAccessError, contentAccessOwner, contentAccessProject, type ContentAccessRole } from "../contracts.js";
import type { SQL } from "bun";
import { mysqlInteger } from "../../database/mysql-model.js";
import type { ContentAccessRepository } from "./ports.js";
const roleValue = (role: unknown): ContentAccessRole | null => {
  if (role === null || role === "reader" || role === "contributor" || role === "blocked") return role;
  throw new ContentAccessError("unavailable");
};
interface MembershipCatalog {
  readonly sql: SQL;
  readonly inTransaction: boolean;
  atomic<T>(work: () => Promise<T>): Promise<T>;
  view<T>(work: () => Promise<T>): Promise<T>;
  project(id: string): Promise<unknown>;
}
/** Membership and new-project reservations share the catalog transaction; no ACL cache can outlive revocation. */
export class MySQLContentAccessStore implements ContentAccessRepository {
  constructor(private readonly catalog: MembershipCatalog) {}
  private async protect<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ContentAccessError) throw error;
      const failure = new ContentAccessError("unavailable");
      failure.cause = error;
      throw failure;
    }
  }
  async revision() {
    return this.protect(async () => {
      const r = (await this.catalog.sql`SELECT revision FROM panda_force_content_access_meta WHERE id=1`)[0];
      return r ? mysqlInteger(r.revision) : 0;
    });
  }
  async role(owner: string, project: string) {
    return this.protect(async () =>
      roleValue(
        (
          await this.catalog
            .sql`SELECT role FROM panda_force_content_access_grants WHERE owner=${owner} AND project=${project}`
        )[0]?.role ?? null,
      ),
    );
  }
  async roles(owner: string, projects: readonly string[]): Promise<Map<string, ContentAccessRole>> {
    contentAccessOwner(owner);
    for (const p of projects) contentAccessProject(p);
    if (projects.length > 10000) throw new ContentAccessError("unavailable");
    if (!projects.length) return new Map();
    return this.protect(
      async () =>
        new Map(
          (
            await this.catalog.sql.unsafe(
              "SELECT project,role FROM panda_force_content_access_grants WHERE owner=? AND project IN (" +
                projects.map(() => "?").join(",") +
                ")",
              [owner, ...projects],
            )
          ).map((r: { project: string; role: unknown }) => {
            const role = roleValue(r.role);
            if (!role) throw new ContentAccessError("unavailable");
            return [r.project, role];
          }),
        ),
    );
  }
  async grants(project: string) {
    return this.protect(() =>
      this.catalog.view(async () => ({
        revision: await this.revision(),
        grants: (
          await this.catalog
            .sql`SELECT owner,role,updatedAt FROM panda_force_content_access_grants WHERE project=${project} ORDER BY owner`
        ).map((r: { owner: string; role: unknown; updatedAt: unknown }) => {
          contentAccessOwner(r.owner);
          const role = roleValue(r.role);
          if (!role) throw new ContentAccessError("unavailable");
          return { owner: r.owner, role, updatedAt: mysqlInteger(r.updatedAt) };
        }),
      })),
    );
  }
  async set(
    actor: string,
    project: string,
    owner: string,
    role: ContentAccessRole | null,
    revision: number,
    now: number,
  ) {
    contentAccessOwner(actor);
    contentAccessOwner(owner);
    contentAccessProject(project);
    if (
      project === "personal" ||
      ![null, "reader", "contributor", "blocked"].includes(role) ||
      !Number.isSafeInteger(revision) ||
      !Number.isSafeInteger(now)
    )
      throw new ContentAccessError("invalidInput");
    return this.protect(() =>
      this.catalog.atomic(async () => {
        await this.catalog.project(project);
        await this.catalog
          .sql`INSERT INTO panda_force_content_access_meta(id,revision) VALUES(1,0) ON DUPLICATE KEY UPDATE id=VALUES(id)`;
        if ((await this.revision()) !== revision) throw new ContentAccessError("conflict");
        const previous = await this.role(owner, project);
        if (previous === role) return this.grants(project);
        if (role) {
          const counts = (
            await this.catalog
              .sql`SELECT COUNT(*) n,COALESCE(SUM(project=${project}),0) projectTotal FROM panda_force_content_access_grants`
          )[0];
          if (previous === null && (Number(counts.n) >= 10000 || Number(counts.projectTotal) >= 1000))
            throw new ContentAccessError("unavailable");
          await this.catalog
            .sql`INSERT INTO panda_force_content_access_grants(project,owner,role,updatedAt) VALUES(${project},${owner},${role},${now}) ON DUPLICATE KEY UPDATE role=VALUES(role),updatedAt=VALUES(updatedAt)`;
        } else
          await this.catalog
            .sql`DELETE FROM panda_force_content_access_grants WHERE project=${project} AND owner=${owner}`;
        await this.catalog.sql`UPDATE panda_force_content_access_meta SET revision=revision+1 WHERE id=1`;
        await this.catalog
          .sql`INSERT INTO panda_force_content_access_changes(revision,project,owner,role,actor,createdAt) VALUES(${revision + 1},${project},${owner},${role},${actor},${now})`;
        return this.grants(project);
      }),
    );
  }
  async reserveCreator(owner: string, project: string, now: number) {
    if (!this.catalog.inTransaction || project === "personal") throw new ContentAccessError("invalidInput");
    contentAccessOwner(owner);
    contentAccessProject(project);
    if ((await this.role(owner, project)) !== null) throw new ContentAccessError("conflict");
    await this.set(owner, project, owner, "contributor", await this.revision(), now);
  }
}
