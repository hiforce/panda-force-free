import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { SearchError, type SearchSourceDefinition } from "../../../shared/search/contracts.js";
import { searchId, searchRecord, searchText } from "../../../shared/search/validation.js";
export class MySQLSearchSourceRegistry {
  constructor(private db: MySQLMetadataContext) {}
  async list() {
    return await this.db.atomic(async () => {
      return (
        await this.db.all<{
          descriptor: string;
        }>("SELECT descriptor FROM panda_force_search_sources ORDER BY id", [])
      ).map((x) => JSON.parse(x.descriptor) as SearchSourceDefinition);
    });
  }
  async get(id: string) {
    return await this.db.atomic(async () => {
      const p = await this.db.one<{
        descriptor: string;
      }>("SELECT descriptor FROM panda_force_search_sources WHERE id=?", [searchId(id)]);
      if (!p) throw new SearchError("notFound", 404);
      return JSON.parse(p.descriptor) as SearchSourceDefinition;
    });
  }
  async binding() {
    return await this.db.atomic(async () => {
      return (await this.db.one<{
        source: string | null;
        revision: number;
      }>("SELECT source,revision FROM panda_force_search_binding WHERE id=1", []))!;
    });
  }
  async save(value: unknown, expected: number, available: (source: SearchSourceDefinition) => void) {
    return await this.db.atomic(async () => {
      const p = searchRecord(value, ["id", "name", "kind", "connection", "knowledge", "enabled"]);
      if (!["local", "elasticsearch"].includes(String(p.kind)) || typeof p.enabled !== "boolean")
        throw new SearchError("invalidInput");
      const descriptor: SearchSourceDefinition = {
        id: searchId(p.id),
        name: searchText(p.name, 120),
        kind: p.kind as SearchSourceDefinition["kind"],
        connection: p.connection === null ? null : searchId(p.connection),
        knowledge: p.knowledge === null ? null : searchId(p.knowledge),
        enabled: p.enabled,
        revision: expected + 1,
      };
      available(descriptor);
      return await this.db.atomic(async () => {
        const old = await this.db.one<{
          revision: number;
        }>("SELECT revision FROM panda_force_search_sources WHERE id=?", [descriptor.id]);
        if ((old?.revision ?? 0) !== expected) throw new SearchError("conflict", 409);
        if (!descriptor.enabled && (await this.binding()).source === descriptor.id)
          throw new SearchError("conflict", 409);
        if (!old && (await this.list()).length >= 32) throw new SearchError("limit", 409);
        await this.db.execute(
          "INSERT INTO panda_force_search_sources VALUES(?,?,?) ON DUPLICATE KEY UPDATE descriptor=VALUES(descriptor),revision=VALUES(revision)",
          [descriptor.id, JSON.stringify(descriptor), descriptor.revision],
        );
        await this.db.execute(
          "UPDATE panda_force_search_scopes SET requested=requested+1,state='queued',token=NULL,leaseUntil=NULL,attempts=0 WHERE source=? AND state!='disabled'",
          [descriptor.id],
        );
        return descriptor;
      });
    });
  }
  async activate(id: string, revision: number, sourceRevision: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const source = await this.get(id);
        if (!source.enabled) throw new SearchError("configuration", 409);
        if (source.revision !== sourceRevision) throw new SearchError("conflict", 409);
        const r = await this.db.execute(
          "UPDATE panda_force_search_binding SET source=?,revision=revision+1 WHERE id=1 AND revision=?",
          [source.id, revision],
        );
        if (r.changes !== 1) throw new SearchError("conflict", 409);
        return await this.binding();
      });
    });
  }
}
