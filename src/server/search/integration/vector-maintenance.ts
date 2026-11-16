import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import type { Database } from "bun:sqlite";
import type { RouteContext } from "../../http/router.js";
import { searchRecord, searchId, searchSettings } from "../../../shared/search/validation.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { ResourceScanRunner } from "../resources/scan-runner.js";
import { SearchResourceScans } from "../storage/resource-scans.js";
import type { IndexResourceRegistry } from "../resources/contracts.js";
import type { ResourceScanStore, ResourceScanTarget } from "../resources/scan-contracts.js";
import type { SearchConnections } from "./connections.js";
import type { SearchSourceRegistry } from "../storage/registry.js";
import type { VectorSealStore } from "../providers/vector-seal.js";
import { vectorResourceOwner } from "./vector-resources.js";
export function createVectorMaintenance(options: {
  db: Database | null;
  scans?: MetadataStore<ResourceScanStore>;
  scopes?: () => Promise<{ source: string; settings: string }[]>;
  connections: MetadataStore<SearchConnections>;
  sources: MetadataStore<SearchSourceRegistry>;
  instance: string;
  resources: MetadataStore<IndexResourceRegistry>;
  seals: VectorSealStore;
  admin(context: RouteContext): void;
  report(error: unknown): void;
}) {
  const { connections, sources, instance, resources, seals, admin, report } = options,
    scans = options.scans ?? new SearchResourceScans(options.db!),
    targets = async (): Promise<ResourceScanTarget[]> => {
      const scopes = options.scopes
          ? await options.scopes()
          : options
              .db!.query<{ source: string; settings: string }, []>("SELECT source,settings FROM search_scopes")
              .all(),
        used = new Set<string | null>();
      for (const row of scopes) {
        try {
          const s = searchSettings(JSON.parse(row.settings)),
            source = await sources.get(row.source);
          if (s.enabled && s.vector && source.enabled) used.add(source.knowledge);
        } catch {
          /* Invalid primary rules cannot enable automatic maintenance. */
        }
      }
      const active = new Set((await connections.knowledge()).filter((k) => used.has(k.id)).map((k) => k.vectors)),
        entries: ResourceScanTarget[] = [];
      for (const connection of (await connections.list()).filter((c) => c.kind === "milvus")) {
        const owner = vectorResourceOwner(await connections.http(connection.id), instance, resources, seals, report);
        entries.push({
          connection: connection.id,
          owner,
          automatic: active.has(connection.id) || (await resources.page(owner.storage.id)).length > 0,
          preferred: active.has(connection.id),
        });
      }
      const automatic = new Set(entries.filter((e) => e.automatic).map((e) => e.owner.storage.id));
      return entries.map((e) => ({ ...e, automatic: automatic.has(e.owner.storage.id) }));
    },
    runner = new ResourceScanRunner(scans, targets, report),
    target = async (id: unknown) => {
      const selected = (await targets()).find((t) => t.connection === searchId(id));
      if (!selected) throw new SearchError("notFound", 404);
      return selected;
    };
  return {
    api: {
      async vectorStorage(ctx: RouteContext, connection: unknown) {
        admin(ctx);
        const t = await target(connection);
        return scans.view(t.owner.storage.id, t.automatic);
      },
      async checkVectorStorage(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["connection", "operationId"]),
          t = await target(p.connection);
        await scans.request(t.owner.storage.id, searchId(p.operationId), t.connection);
        runner.kick();
        return scans.view(t.owner.storage.id, t.automatic);
      },
    },
    start: () => runner.start(),
    close: () => runner.close(),
  };
}
