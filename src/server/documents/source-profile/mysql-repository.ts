import type { MySQLDocumentSession } from "../mysql-session.js";
import type { SiteSourceProfile } from "../../../shared/sites/profile.js";
import { siteSourceProfile } from "../../../shared/sites/profile.js";
import type { MySQLSpaceRepository } from "../mysql-space-repository.js";
import { DocumentError } from "../errors.js";
/** Space version is the single optimistic lock for theme and source configuration changes. */
export class MySQLSourceProfileRepository {
  constructor(
    private db: MySQLDocumentSession,
    private spaces: MySQLSpaceRepository,
  ) {}
  async get(spaceId: string): Promise<SiteSourceProfile | null> {
    const row = await this.db.one<{
      profile: string;
    }>("SELECT profile FROM panda_force_document_site_profiles WHERE spaceId=?", [spaceId]);
    return row ? siteSourceProfile(JSON.parse(row.profile)) : null;
  }
  async put(spaceId: string, profile: SiteSourceProfile, version: number) {
    return await this.db.transaction(async () => {
      if ((await this.spaces.get(spaceId)).version !== version) throw new DocumentError("spaceConflict", 409);
      await this.db.run(
        "INSERT INTO panda_force_document_site_profiles VALUES (?,?) ON DUPLICATE KEY UPDATE profile=VALUES(profile)",
        [spaceId, JSON.stringify(profile)],
      );
      await this.db.run("UPDATE panda_force_document_spaces SET version=version+1,updatedAt=? WHERE id=?", [
        Date.now(),
        spaceId,
      ]);
      return await this.spaces.get(spaceId);
    });
  }
}
