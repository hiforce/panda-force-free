import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { CredentialCipher } from "../../connections/credentials/cipher.js";
import { connectionKey } from "../../connections/integration/key-provider.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { searchId, searchRecord, searchText } from "../../../shared/search/validation.js";
import type { SearchConnection, KnowledgeConnection } from "../connection.js";
import { SearchHttp } from "../providers/http.js";

/** Immutable connection profiles pin endpoints and credentials independently of source activation. */
export class SearchConnections {
  private cipher: CredentialCipher;
  constructor(
    private db: Database,
    private configured: SearchConnection[],
    root: string,
    private configuredKnowledge: KnowledgeConnection[] = [],
  ) {
    const count = () => Number(db.query<{ n: number }, []>("SELECT count(*) n FROM search_connections").get()!.n);
    this.cipher = new CredentialCipher(
      connectionKey(root, { count }, { PANDA_FORCE_CONNECTION_KEY_FILE: join(root, "config", "search-key") }).provider,
    );
  }
  knowledge() {
    return [
      ...this.configuredKnowledge,
      ...this.db
        .query<{ descriptor: string }, []>("SELECT descriptor FROM search_knowledge ORDER BY id")
        .all()
        .map((r) => JSON.parse(r.descriptor) as KnowledgeConnection),
    ];
  }
  addKnowledge(input: unknown) {
    const p = searchRecord(input, ["id", "vectors", "embeddings"]),
      v = { id: searchId(p.id), vectors: searchId(p.vectors), embeddings: searchId(p.embeddings) };
    if (this.get(v.vectors).kind !== "milvus" || !["ollama", "openai"].includes(this.get(v.embeddings).kind))
      throw new SearchError("configuration", 409);
    if (this.knowledge().length >= 16) throw new SearchError("limit", 409);
    if (this.knowledge().some((k) => k.id === v.id)) throw new SearchError("conflict", 409);
    this.db.query("INSERT INTO search_knowledge VALUES(?,?)").run(v.id, JSON.stringify(v));
    return v;
  }
  list() {
    return [
      ...this.configured.map((c) => ({
        id: c.id,
        kind: c.kind,
        url: c.url,
        model: c.model,
        dimensions: c.dimensions,
        prefix: c.prefix,
        username: c.username,
        managed: false,
      })),
      ...this.db
        .query<{ descriptor: string }, []>("SELECT descriptor FROM search_connections ORDER BY id")
        .all()
        .map((r) => ({ ...(JSON.parse(r.descriptor) as SearchConnection), managed: true })),
    ];
  }
  get(id: string) {
    const configured = this.configured.find((c) => c.id === id);
    if (configured) return configured;
    const row = this.db
      .query<{ descriptor: string }, [string]>("SELECT descriptor FROM search_connections WHERE id=?")
      .get(searchId(id));
    if (!row) throw new SearchError("configuration", 409);
    return JSON.parse(row.descriptor) as SearchConnection;
  }
  http(id: string) {
    const c = this.get(id);
    return new SearchHttp(c, async () => {
      const row = this.db
        .query<{ envelope: string; binding: string }, [string]>(
          "SELECT envelope,binding FROM search_connections WHERE id=?",
        )
        .get(id);
      if (!row) return {};
      return (await this.cipher.open(JSON.parse(row.binding), JSON.parse(row.envelope))) as {
        password?: string;
        apiKey?: string;
        ca?: string;
      };
    });
  }
  async add(input: unknown) {
    const p = searchRecord(input, [
        "id",
        "kind",
        "url",
        "username",
        "password",
        "apiKey",
        "ca",
        "model",
        "dimensions",
        "prefix",
      ]),
      id = searchId(p.id),
      kind = p.kind;
    if (this.list().length >= 32) throw new SearchError("limit", 409);
    if (this.list().some((c) => c.id === id)) throw new SearchError("conflict", 409);
    if (!["elasticsearch", "milvus", "ollama", "openai"].includes(String(kind))) throw new SearchError("invalidInput");
    const url = new URL(searchText(p.url, 2000));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new SearchError("invalidInput");
    const c: SearchConnection = { id, kind: kind as SearchConnection["kind"], url: url.href.replace(/\/$/, "") };
    for (const k of ["username", "model", "prefix"] as const) if (p[k]) c[k] = searchText(p[k], 200);
    if (c.prefix && !/^[a-z][a-z0-9_]{0,24}$/.test(c.prefix)) throw new SearchError("invalidInput");
    if (p.dimensions !== undefined) {
      if (!Number.isSafeInteger(p.dimensions) || Number(p.dimensions) < 1 || Number(p.dimensions) > 65536)
        throw new SearchError("invalidInput");
      c.dimensions = Number(p.dimensions);
    }
    if (["ollama", "openai"].includes(c.kind) && (!c.model || !c.dimensions)) throw new SearchError("invalidInput");
    const credential: Record<string, string> = {};
    for (const k of ["password", "apiKey", "ca"] as const)
      if (p[k]) {
        if (typeof p[k] !== "string" || p[k].length > 16384) throw new SearchError("invalidInput");
        credential[k] = p[k];
      }
    if ((credential.password && !c.username) || (credential.password && credential.apiKey))
      throw new SearchError("invalidInput");
    const binding = { connectionId: randomUUID(), connectorId: "search." + c.kind, ownerId: "installation" },
      envelope = await this.cipher.seal(binding, credential);
    this.db
      .transaction(() => {
        if (this.list().some((c) => c.id === id) || this.list().length >= 32) throw new SearchError("conflict", 409);
        this.db
          .query("INSERT INTO search_connections VALUES(?,?,?,?)")
          .run(id, JSON.stringify(c), JSON.stringify(envelope), JSON.stringify(binding));
      })
      .immediate();
    return c;
  }
}
