import type { Database } from "bun:sqlite";
import type { SiteSourceProfile } from "../../../shared/sites/profile.js";
import { siteSourceProfile } from "../../../shared/sites/profile.js";
import type { SpaceRepository } from "../space-repository.js";
import { DocumentError } from "../errors.js";

/** Space version is the single optimistic lock for theme and source configuration changes. */
export class SourceProfileRepository {
  constructor(
    private db: Database,
    private spaces: SpaceRepository,
  ) {}
  get(spaceId: string): SiteSourceProfile | null {
    const row = this.db
      .query<{ profile: string }, [string]>("SELECT profile FROM document_site_profiles WHERE spaceId=?")
      .get(spaceId);
    return row ? siteSourceProfile(JSON.parse(row.profile)) : null;
  }
  put(spaceId: string, profile: SiteSourceProfile, version: number) {
    return this.db
      .transaction(() => {
        if (this.spaces.get(spaceId).version !== version) throw new DocumentError("spaceConflict", 409);
        this.db
          .query(
            "INSERT INTO document_site_profiles VALUES (?,?) ON CONFLICT(spaceId) DO UPDATE SET profile=excluded.profile",
          )
          .run(spaceId, JSON.stringify(profile));
        this.db.query("UPDATE document_spaces SET version=version+1,updatedAt=? WHERE id=?").run(Date.now(), spaceId);
        return this.spaces.get(spaceId);
      })
      .immediate();
  }
}
