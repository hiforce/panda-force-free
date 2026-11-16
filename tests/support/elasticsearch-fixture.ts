import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProjectedSearchText } from "../../src/server/search/providers/es-integrity.js";

interface StoredIndex {
  uuid: string;
  sequence: number;
  mappings: Record<string, unknown>;
  documents: Map<string, ProjectedSearchText>;
  visible: Map<string, ProjectedSearchText>;
}
/** Stateful HTTP fixture exercises actual adapter writes, checkpoints, visibility and scroll cleanup. */
export async function elasticsearchFixture() {
  const indexes = new Map<string, StoredIndex>(),
    scrolls = new Map<string, { hits: { _id: string; _source: ProjectedSearchText }[]; size: number }>(),
    calls: { path: string; method: string; body: Record<string, unknown> }[] = [],
    faults = {
      healthWaits: 0,
      refresh: false,
      partial: false,
      timedOut: false,
      scrollExpired: false,
      status: 0,
      path: "",
    };
  let healthChecks = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost"),
        path = url.pathname;
      let bytes = "";
      for await (const chunk of req) bytes += chunk.toString();
      const body = bytes ? (JSON.parse(bytes) as Record<string, unknown>) : {},
        method = req.method!;
      calls.push({ path, method, body });
      const reply = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (faults.status && path.includes(faults.path))
        return reply({ error: "synthetic-upstream-error" }, faults.status);
      if (path === "/") return reply({ version: { number: "7.12.1" } });
      if (path.startsWith("/_cluster/health/")) {
        const waiting = ++healthChecks <= faults.healthWaits;
        return reply({ timed_out: waiting, active_primary_shards: waiting ? 0 : 1 }, waiting ? 408 : 200);
      }
      const page = (id: string) => {
        const context = scrolls.get(id)!;
        return {
          _scroll_id: id,
          timed_out: faults.timedOut,
          _shards: { successful: 1, failed: faults.partial ? 1 : 0 },
          hits: { hits: context.hits.splice(0, context.size) },
        };
      };
      if (path === "/_search/scroll") {
        if (method === "DELETE") {
          for (const id of body.scroll_id as string[]) scrolls.delete(id);
          return reply({ succeeded: true });
        }
        const id = String(body.scroll_id);
        if (faults.scrollExpired || !scrolls.has(id)) return reply({ error: "search_context_missing_exception" }, 404);
        return reply(page(id));
      }
      const [name, action, encodedId] = path.slice(1).split("/"),
        stored = indexes.get(name!);
      if (!action && method === "PUT") {
        if (stored) return reply({ error: "resource_already_exists_exception" }, 400);
        indexes.set(name!, {
          uuid: randomUUID(),
          sequence: -1,
          mappings: structuredClone(body.mappings as Record<string, unknown>),
          documents: new Map(),
          visible: new Map(),
        });
        return reply({ acknowledged: true });
      }
      if (!stored) return reply({ error: "index_not_found_exception", status: 404 }, 404);
      if (!action && method === "DELETE") {
        indexes.delete(name!);
        return reply({ acknowledged: true });
      }
      if (action === "_doc") {
        const id = decodeURIComponent(encodedId!);
        if (method === "PUT") stored.documents.set(id, structuredClone(body) as unknown as ProjectedSearchText);
        else if (method === "DELETE") stored.documents.delete(id);
        stored.sequence++;
        return reply({ result: method === "DELETE" ? "deleted" : "created" });
      }
      if (action === "_refresh") {
        if (!faults.refresh) stored.visible = new Map(structuredClone([...stored.documents]));
        return reply({ _shards: { successful: faults.refresh ? 0 : 1, failed: faults.refresh ? 1 : 0 } });
      }
      if (action === "_stats")
        return reply({
          indices: {
            [name!]: {
              uuid: stored.uuid,
              shards: { "0": [{ routing: { primary: true }, seq_no: { max_seq_no: stored.sequence } }] },
            },
          },
        });
      if (action === "_mapping") return reply({ [name!]: { mappings: stored.mappings } });
      if (action === "_search" && url.searchParams.has("scroll")) {
        const id = randomUUID();
        scrolls.set(id, {
          size: Number(body.size),
          hits: [...stored.visible].map(([_id, _source]) => ({ _id, _source: structuredClone(_source) })),
        });
        return reply(page(id));
      }
      if (action === "_search")
        return reply({
          _shards: { successful: 1, failed: faults.partial ? 1 : 0 },
          timed_out: faults.timedOut,
          hits: {
            hits: [...stored.visible]
              .slice(0, Number(body.size))
              .map(([_id, _source]) => ({ _id, _score: 1, _source })),
          },
        });
      reply({ error: "unexpected_request" }, 400);
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"fixture_error"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    indexes,
    scrolls,
    calls,
    faults,
    healthChecks: () => healthChecks,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
