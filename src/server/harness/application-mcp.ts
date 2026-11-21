import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { isRecord } from "../../shared/records.js";
import { stableJson } from "../../shared/stable-json.js";
import type {
  ApplicationRunCallbacks,
  ApplicationRunScope,
  ApplicationToolDefinition,
} from "../../shared/engine/application-tools.js";
import type { HarnessApplicationPolicy } from "./ports.js";

/** A run-scoped loopback MCP endpoint exposes exactly the application's leased tools. */
export async function applicationMcp(
  tools: readonly ApplicationToolDefinition[],
  callbacks: ApplicationRunCallbacks,
  scope: () => ApplicationRunScope | null,
) {
  const token = randomBytes(32).toString("hex"),
    names = new Set(tools.map((tool) => tool.name)),
    calls = new Map<string, { digest: string; result: Promise<unknown> }>();
  let stopped = false;
  const server = createServer(async (req, res) => {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (
      stopped ||
      callbacks.signal.aborted ||
      req.headers.authorization !== `Bearer ${token}` ||
      req.headers.origin ||
      req.url !== "/mcp"
    )
      return reply(403);
    if (req.method !== "POST") return reply(405);
    let id: string | number | null = null;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1048576) return reply(413);
        chunks.push(Buffer.from(chunk));
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!isRecord(input) || input.jsonrpc !== "2.0") return reply(400);
      id = typeof input.id === "string" || typeof input.id === "number" ? input.id : null;
      if (id === null && String(input.method).startsWith("notifications/")) return reply(202);
      let result: unknown;
      if (input.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "pandaforce-application", version: "1" },
        };
      else if (input.method === "ping") result = {};
      else if (input.method === "tools/list") result = { tools };
      else if (input.method === "tools/call") {
        const params = input.params,
          current = scope();
        if (
          !current ||
          !isRecord(params) ||
          typeof params.name !== "string" ||
          !names.has(params.name) ||
          !isRecord(params.arguments)
        )
          throw Error("Invalid application tool");
        const key = String(id),
          digest = stableJson(params),
          previous = calls.get(key);
        if (previous && previous.digest !== digest) throw Error("Conflicting application tool");
        if (calls.size >= 128 && !previous) throw Error("Application tool budget exceeded");
        const work =
          previous?.result ??
          (async () => {
            callbacks.signal.throwIfAborted();
            const result = await callbacks.call({
              ...current,
              callId: key,
              name: params.name as string,
              arguments: params.arguments,
            });
            callbacks.signal.throwIfAborted();
            return {
              isError: !result.success,
              content: [
                { type: "text", text: result.text },
                ...(result.images ?? []).flatMap((url) => {
                  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
                  return match ? [{ type: "image", mimeType: match[1], data: match[2] }] : [];
                }),
              ],
            };
          })();
        calls.set(key, { digest, result: work });
        result = await work;
      } else return reply(200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method unavailable" } });
      reply(200, { jsonrpc: "2.0", id, result });
    } catch {
      reply(200, { jsonrpc: "2.0", id, error: { code: -32602, message: "Application operation unavailable" } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Application endpoint unavailable");
  const mcpServer: HarnessApplicationPolicy["mcpServer"] = {
    type: "http",
    name: "panda",
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  };
  return {
    mcpServer,
    async close() {
      stopped = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
