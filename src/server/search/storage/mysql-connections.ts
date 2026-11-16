import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { FileCredentialKey, initializeCredentialKey } from "../../connections/credentials/file-key.js";
import { CredentialError } from "../../connections/credentials/errors.js";
import { CredentialCipher } from "../../connections/credentials/cipher.js";

import { SearchError } from "../../../shared/search/contracts.js";
import { searchId, searchRecord, searchText } from "../../../shared/search/validation.js";
import type { SearchConnection, KnowledgeConnection } from "../connection.js";
import { SearchHttp } from "../providers/http.js";
/** Immutable connection profiles pin endpoints and credentials independently of source activation. */
export class MySQLSearchConnections {
  private cipher: CredentialCipher;
  constructor(
    private db: MySQLMetadataContext,
    private configured: SearchConnection[],
    root: string,
    private configuredKnowledge: KnowledgeConnection[] = [],
  ) {
    const path = join(root, "config", "search-key"),
      file = new FileCredentialKey(path);
    this.cipher = new CredentialCipher({
      async load() {
        try {
          await access(path);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" ||
            Number(
              (await db.one<{
                n: number;
              }>("SELECT COUNT(*) n FROM panda_force_search_connections"))!.n,
            )
          )
            throw new CredentialError("keyUnavailable");
          await initializeCredentialKey(path);
        }
        return file.load();
      },
    });
  }
  async knowledge() {
    return await this.db.atomic(async () => {
      return [
        ...this.configuredKnowledge,
        ...(
          await this.db.all<{
            descriptor: string;
          }>("SELECT descriptor FROM panda_force_search_knowledge ORDER BY id", [])
        ).map((r) => JSON.parse(r.descriptor) as KnowledgeConnection),
      ];
    });
  }
  async addKnowledge(input: unknown) {
    return await this.db.atomic(async () => {
      const p = searchRecord(input, ["id", "vectors", "embeddings"]),
        v = { id: searchId(p.id), vectors: searchId(p.vectors), embeddings: searchId(p.embeddings) };
      if (
        (await this.get(v.vectors)).kind !== "milvus" ||
        !["ollama", "openai"].includes((await this.get(v.embeddings)).kind)
      )
        throw new SearchError("configuration", 409);
      if ((await this.knowledge()).length >= 16) throw new SearchError("limit", 409);
      if ((await this.knowledge()).some((k) => k.id === v.id)) throw new SearchError("conflict", 409);
      await this.db.execute("INSERT INTO panda_force_search_knowledge VALUES(?,?)", [v.id, JSON.stringify(v)]);
      return v;
    });
  }
  async list() {
    return await this.db.atomic(async () => {
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
        ...(
          await this.db.all<{
            descriptor: string;
          }>("SELECT descriptor FROM panda_force_search_connections ORDER BY id", [])
        ).map((r) => ({ ...(JSON.parse(r.descriptor) as SearchConnection), managed: true })),
      ];
    });
  }
  async get(id: string) {
    return await this.db.atomic(async () => {
      const configured = this.configured.find((c) => c.id === id);
      if (configured) return configured;
      const row = await this.db.one<{
        descriptor: string;
      }>("SELECT descriptor FROM panda_force_search_connections WHERE id=?", [searchId(id)]);
      if (!row) throw new SearchError("configuration", 409);
      return JSON.parse(row.descriptor) as SearchConnection;
    });
  }
  async http(id: string) {
    return await this.db.atomic(async () => {
      const c = await this.get(id);
      return new SearchHttp(c, async () => {
        const row = await this.db.one<{
          envelope: string;
          binding: string;
        }>("SELECT envelope,binding FROM panda_force_search_connections WHERE id=?", [id]);
        if (!row) return {};
        return (await this.cipher.open(JSON.parse(row.binding), JSON.parse(row.envelope))) as {
          password?: string;
          apiKey?: string;
          ca?: string;
        };
      });
    });
  }
  async add(input: unknown) {
    return await this.db.atomic(async () => {
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
      if ((await this.list()).length >= 32) throw new SearchError("limit", 409);
      if ((await this.list()).some((c) => c.id === id)) throw new SearchError("conflict", 409);
      if (!["elasticsearch", "milvus", "ollama", "openai"].includes(String(kind)))
        throw new SearchError("invalidInput");
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
      await this.db.atomic(async () => {
        if ((await this.list()).some((c) => c.id === id) || (await this.list()).length >= 32)
          throw new SearchError("conflict", 409);
        await this.db.execute("INSERT INTO panda_force_search_connections VALUES(?,?,?,?)", [
          id,
          JSON.stringify(c),
          JSON.stringify(envelope),
          JSON.stringify(binding),
        ]);
      });
      return c;
    });
  }
}
