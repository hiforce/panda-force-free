import type { VectorRow } from "../../src/server/search/providers/vector-rows.js";

/** A fault-injectable REST peer tests real application HTTP and files; it is not a physical Milvus proof. */
export function milvusHttpFixture() {
  const collections = new Map<string, { identity: string; marker: string; rows: Map<string, VectorRow> }>(),
    calls: string[] = [],
    faults = { createUnknown: 0, drop: 0 };
  let identity = 448707763883002001n;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer fixture-vector-key")
        return new Response("", { status: 401 });
      const path = new URL(request.url).pathname.split("/").slice(-2).join("/"),
        body = (await request.json()) as {
          collectionName: string;
          description?: string;
          data: VectorRow[];
          filter: string;
          outputFields: string[];
          limit: number;
        };
      calls.push(path);
      const found = collections.get(body.collectionName),
        ok = (data: unknown = {}) => Response.json({ code: 0, data });
      switch (path) {
        case "collections/list":
          return ok([...collections.keys()]);
        case "collections/has":
          return ok({ has: !!found });
        case "collections/create": {
          if (found) return Response.json({ code: 1 });
          collections.set(body.collectionName, {
            identity: String(identity++),
            marker: body.description ?? "",
            rows: new Map(),
          });
          if (faults.createUnknown-- > 0) return new Response("", { status: 503 });
          return ok();
        }
        case "collections/drop": {
          if (faults.drop-- > 0) return new Response("", { status: 503 });
          collections.delete(body.collectionName);
          return ok();
        }
        case "collections/describe": {
          if (!found) return Response.json({ code: 1 });
          return ok({
            collectionName: body.collectionName,
            collectionID: found.identity,
            description: found.marker,
            autoId: false,
            enableDynamicField: true,
            load: "LoadStateLoaded",
            fields: [
              { name: "id", type: "VarChar", primaryKey: true },
              { name: "vector", type: "FloatVector", params: [{ key: "dim", value: "4" }] },
            ],
            indexes: [{ fieldName: "vector", metricType: "COSINE" }],
          });
        }
        case "entities/insert": {
          if (!found) return Response.json({ code: 1 });
          for (const row of body.data) found.rows.set(row.id, row);
          return ok({ insertCount: body.data.length });
        }
        case "entities/query": {
          if (!found) return Response.json({ code: 1 });
          if (body.outputFields.includes("count(*)")) return ok([{ "count(*)": found.rows.size }]);
          const ids = JSON.parse(body.filter.slice("id in ".length)) as string[];
          return ok(ids.flatMap((id) => (found.rows.has(id) ? [found.rows.get(id)!] : [])));
        }
        case "entities/search":
          return found
            ? ok([...found.rows.keys()].slice(0, body.limit).map((id) => ({ id, distance: 1 })))
            : Response.json({ code: 1 });
        default:
          return new Response("", { status: 400 });
      }
    },
  });
  return { server, collections, calls, faults, endpoint: server.url.href.slice(0, -1) };
}
