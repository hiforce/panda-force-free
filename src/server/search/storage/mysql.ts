import type { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { SearchConnection, KnowledgeConnection } from "../connection.js";
import type { SearchPersistence } from "./persistence.js";
import { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";
import { MySQLEmbeddingBudget } from "./mysql-embedding-budget.js";
import { MySQLSearchSourceRegistry } from "./mysql-registry.js";
import { MySQLSearchJobs } from "./mysql-jobs.js";
import { MySQLSearchProjectPolicies } from "./mysql-project-policies.js";
import { MySQLAnalyzerStore } from "./mysql-analyzer-store.js";
import { MySQLSearchConnections } from "./mysql-connections.js";
import { MySQLSearchIndexResources } from "./mysql-resources.js";
import { MySQLSearchAudits } from "./mysql-audits.js";
import { MySQLSearchResourceScans } from "./mysql-resource-scans.js";
/** Native asynchronous facets share a module transaction context; no provider is contacted while selecting persistence. */
export async function createMySQLSearchPersistence(
  sql: SQL,
  options: { stateRoot: string; connections: SearchConnection[]; knowledge: KnowledgeConnection[] },
): Promise<SearchPersistence> {
  const db = new MySQLMetadataContext(sql, "search");
  const instance = await db.atomic(async () => {
    const old = await db.one<{ value: string }>("SELECT value FROM panda_force_search_meta WHERE id='instance'");
    if (old) return old.value;
    const value = randomBytes(16).toString("hex");
    await db.execute("INSERT INTO panda_force_search_meta(id,value) VALUES('instance',?)", [value]);
    await db.execute("INSERT INTO panda_force_search_sources(id,descriptor,revision) VALUES('builtin',?,1)", [
      JSON.stringify({
        id: "builtin",
        name: "Built-in search",
        kind: "local",
        connection: null,
        knowledge: null,
        enabled: true,
        revision: 1,
      }),
    ]);
    await db.execute("INSERT INTO panda_force_search_binding(id,source,revision) VALUES(1,'builtin',1)");
    return value;
  });
  return {
    instance,
    sources: new MySQLSearchSourceRegistry(db),
    jobs: new MySQLSearchJobs(db),
    policies: new MySQLSearchProjectPolicies(db),
    analyzers: new MySQLAnalyzerStore(db, join(options.stateRoot, "plugins", "search-analyzers")),
    connections: new MySQLSearchConnections(db, options.connections, options.stateRoot, options.knowledge),
    resources: new MySQLSearchIndexResources(db),
    audits: new MySQLSearchAudits(db),
    scans: new MySQLSearchResourceScans(db),
    embeddingBudget: (policy, now) =>
      new MySQLEmbeddingBudget(new MySQLMetadataContext(sql, "search-embeddings"), policy, now),
  };
}
