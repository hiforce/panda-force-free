import { CLI_VERSION } from "../shared/cli/version.js";
import type { Readable, Writable } from "node:stream";
import { CLI_MCP_COMMANDS } from "../shared/cli/commands.js";
import { cliCommandSchema, cliCommandArguments, cliCommandAllowed } from "../shared/cli/schema.js";
import { CliError, cliObject, type CliCapability } from "../shared/cli/contracts.js";
import type { PandaClient } from "./client.js";
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
async function* boundedLines(input: Readable) {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    if (bytes.length > 1024 * 1024) throw new CliError("limit", 413);
    pending = Buffer.concat([pending, bytes]);
    let at: number;
    while ((at = pending.indexOf(10)) >= 0) {
      if (at > 1024 * 1024) throw new CliError("limit", 413);
      yield pending.subarray(0, at).toString("utf8");
      pending = pending.subarray(at + 1);
    }
    if (pending.length > 1024 * 1024) throw new CliError("limit", 413);
  }
  if (pending.length) yield pending.toString("utf8");
}
/** Credentials remain inside the client; tool inputs and results contain no authentication material. */
export async function servePandaMcp(client: PandaClient, input: Readable, output: Writable) {
  const session = await client.request("session"),
    grant = session.data as { capabilities: CliCapability[] };
  let initialized = false,
    negotiated = false;
  for await (const line of boundedLines(input)) {
    let id: string | number | null = null,
      response: unknown;
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new CliError("limit", 413);
      const request = cliObject(JSON.parse(line), ["jsonrpc", "id", "method", "params"]);
      if (
        request.jsonrpc !== "2.0" ||
        typeof request.method !== "string" ||
        (request.id !== undefined && typeof request.id !== "number" && typeof request.id !== "string")
      )
        throw new CliError("invalidInput");
      if (request.id === undefined) {
        if (request.method === "notifications/initialized" && negotiated) initialized = true;
        continue;
      }
      id = request.id as string | number;
      let result: unknown;
      if (request.method === "initialize") {
        const p = cliObject(request.params, ["protocolVersion", "capabilities", "clientInfo"]);
        negotiated = true;
        result = {
          protocolVersion: versions.includes(String(p.protocolVersion)) ? p.protocolVersion : versions[0],
          capabilities: { tools: {} },
          serverInfo: { name: "panda", version: CLI_VERSION },
        };
      } else if (request.method === "ping") result = {};
      else {
        if (!initialized) throw new CliError("invalidInput");
        if (request.method === "tools/list")
          result = {
            tools: CLI_MCP_COMMANDS.filter((spec) => grant.capabilities.includes(spec.capability)).map((spec) => ({
              name: "panda_" + spec.id.replaceAll(".", "_"),
              description: spec.summary,
              inputSchema: cliCommandSchema(spec, grant.capabilities),
              annotations: {
                readOnlyHint: !["knowledge:write", "knowledge:approve"].includes(spec.capability),
                destructiveHint: false,
                idempotentHint:
                  spec.id !== "search.query" &&
                  (!["knowledge:write", "knowledge:approve"].includes(spec.capability) ||
                    spec.id === "knowledge.create"),
                openWorldHint: false,
              },
            })),
          };
        else if (request.method === "tools/call") {
          const p = cliObject(request.params, ["name", "arguments", "_meta"]),
            spec = CLI_MCP_COMMANDS.find((spec) => "panda_" + spec.id.replaceAll(".", "_") === p.name);
          if (!spec) throw new CliError("notFound", 404);
          try {
            const args = cliCommandArguments(spec, p.arguments);
            if (!cliCommandAllowed(spec, args, grant.capabilities)) throw new CliError("forbidden", 403);
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(await client.execute(spec.id, args)),
                },
              ],
            };
          } catch (error) {
            result = {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: { code: error instanceof CliError ? error.code : "unavailable" } }),
                },
              ],
            };
          }
        } else {
          response = { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
        }
      }
      response ??= { jsonrpc: "2.0", id, result };
    } catch {
      response = { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid request" } };
    }
    if (!output.write(JSON.stringify(response) + "\n"))
      await new Promise<void>((resolve) => output.once("drain", resolve));
  }
}
