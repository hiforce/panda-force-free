import { CliError, cliObject, cliRegistration, cliServer, type CliErrorCode } from "../shared/cli/contracts.js";
import { CLI_COMMANDS, type CliCommandId } from "../shared/cli/commands.js";
import { cliCommandArguments } from "../shared/cli/schema.js";
import type { CliProfiles } from "./profiles.js";
const codes = [
  "invalidInput",
  "authenticationRequired",
  "forbidden",
  "notFound",
  "conflict",
  "limit",
  "unavailable",
  "configuration",
  "notReady",
  "indexChanged",
];
export class PandaClient {
  constructor(
    private readonly profiles: CliProfiles,
    private readonly profile: string,
    private readonly transport = fetch,
    private readonly timeoutMs = 60000,
  ) {}
  async setup(baseUrl: string, apiKey: string) {
    const server = cliServer(baseUrl);
    if (!/^pfk_[a-f0-9]{24}_[a-zA-Z0-9_-]{43}$/.test(apiKey)) throw new CliError("authenticationRequired", 401);
    const response = await this.send(server, apiKey, "setup");
    const registration = cliRegistration({
      ...cliObject(response.data, ["clientId", "kind"]),
      server,
      schema: 1,
      protocol: 1,
      credentialRef: "credentials.json",
    });
    await this.profiles.register(this.profile, registration);
    await this.profiles.login(this.profile, apiKey);
    return { connected: true, profile: this.profile, server, kind: registration.kind };
  }
  async request(path: "session" | "execute", input?: { command: CliCommandId; args: Record<string, unknown> }) {
    const { registration, apiKey } = await this.profiles.credentials(this.profile);
    return this.send(registration.server, apiKey, path, registration.clientId, input);
  }
  private async send(
    server: string,
    apiKey: string,
    path: "setup" | "session" | "execute",
    clientId?: string,
    input?: { command: CliCommandId; args: Record<string, unknown> },
  ) {
    let response: Response;
    try {
      response = await this.transport(server + "/api/cli/v1/" + path, {
        method: input ? "POST" : "GET",
        headers: {
          authorization: "Bearer " + apiKey,
          ...(clientId ? { "x-panda-client-id": clientId } : {}),
          "x-panda-cli-protocol": "1",
          "content-type": "application/json",
        },
        ...(input ? { body: JSON.stringify({ schema: 1, ...input }) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CliError("unavailable", 503);
    }
    if (!response.body) throw new CliError("unavailable", 503);
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 4 * 1024 * 1024) throw new CliError("limit", 413);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error instanceof CliError ? error : new CliError("unavailable", 503);
    } finally {
      reader.releaseLock();
    }
    let body: Record<string, unknown>;
    try {
      body = cliObject(JSON.parse(Buffer.concat(chunks).toString("utf8")), ["schema", "requestId", "data", "error"]);
    } catch {
      throw new CliError("unavailable", 503);
    }
    if (body.schema !== 1 || typeof body.requestId !== "string") throw new CliError("unavailable", 503);
    if (!response.ok) {
      const error = body.error as { code?: unknown } | undefined;
      throw new CliError(
        codes.includes(String(error?.code)) ? (error!.code as CliErrorCode) : "unavailable",
        response.status,
      );
    }
    if (!("data" in body) || "error" in body) throw new CliError("unavailable", 503);
    return body;
  }
  async execute(command: CliCommandId, args: Record<string, unknown>) {
    const spec = CLI_COMMANDS.find((entry) => entry.id === command);
    if (!spec) throw new CliError("notFound", 404);
    return this.request("execute", { command, args: cliCommandArguments(spec, args) });
  }
}
