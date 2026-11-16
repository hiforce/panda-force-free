import type { Database } from "bun:sqlite";
import { SearchError, type SearchSourceDefinition } from "../../../shared/search/contracts.js";
import { searchId, searchRecord, searchText } from "../../../shared/search/validation.js";
export class SearchSourceRegistry {
  constructor(private db: Database) {}
  list() {
    return this.db
      .query<{ descriptor: string }, []>("SELECT descriptor FROM search_sources ORDER BY id")
      .all()
      .map((x) => JSON.parse(x.descriptor) as SearchSourceDefinition);
  }
  get(id: string) {
    const p = this.db
      .query<{ descriptor: string }, [string]>("SELECT descriptor FROM search_sources WHERE id=?")
      .get(searchId(id));
    if (!p) throw new SearchError("notFound", 404);
    return JSON.parse(p.descriptor) as SearchSourceDefinition;
  }
  binding() {
    return this.db
      .query<{ source: string | null; revision: number }, []>("SELECT source,revision FROM search_binding WHERE id=1")
      .get()!;
  }
  save(value: unknown, expected: number, available: (source: SearchSourceDefinition) => void) {
    const descriptor = searchSourceDescriptor(value, expected);
    available(descriptor);
    return this.db
      .transaction(() => {
        const old = this.db
          .query<{ revision: number }, [string]>("SELECT revision FROM search_sources WHERE id=?")
          .get(descriptor.id);
        if ((old?.revision ?? 0) !== expected) throw new SearchError("conflict", 409);
        if (!descriptor.enabled && this.binding().source === descriptor.id) throw new SearchError("conflict", 409);
        if (!old && this.list().length >= 32) throw new SearchError("limit", 409);
        this.db
          .query(
            "INSERT INTO search_sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET descriptor=excluded.descriptor,revision=excluded.revision",
          )
          .run(descriptor.id, JSON.stringify(descriptor), descriptor.revision);
        this.db
          .query(
            "UPDATE search_scopes SET requested=requested+1,state='queued',token=NULL,leaseUntil=NULL,attempts=0 WHERE source=? AND state!='disabled'",
          )
          .run(descriptor.id);
        return descriptor;
      })
      .immediate();
  }
  activate(id: string, revision: number, sourceRevision: number) {
    return this.db
      .transaction(() => {
        const source = this.get(id);
        if (!source.enabled) throw new SearchError("configuration", 409);
        if (source.revision !== sourceRevision) throw new SearchError("conflict", 409);
        const r = this.db
          .query("UPDATE search_binding SET source=?,revision=revision+1 WHERE id=1 AND revision=?")
          .run(source.id, revision);
        if (r.changes !== 1) throw new SearchError("conflict", 409);
        return this.binding();
      })
      .immediate();
  }
}

export function searchSourceDescriptor(value: unknown, expected: number): SearchSourceDefinition {
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
  return descriptor;
}
