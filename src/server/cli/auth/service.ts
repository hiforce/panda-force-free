import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CLI_CAPABILITIES,
  CliError,
  cliId,
  cliObject,
  cliServer,
  cliText,
  type CliCapability,
  type CliClientKind,
  type CliGrant,
  type CliRegistration,
} from "../../../shared/cli/contracts.js";
import type { CliCredentialStore } from "./ports.js";
const digest = (key: string) =>
  createHash("sha256")
    .update("panda-cli-v1:" + key)
    .digest("hex");
export class CliCredentials {
  constructor(
    private readonly store: CliCredentialStore,
    private readonly now = Date.now,
  ) {}
  async issue(
    owner: string,
    server: string,
    input: unknown,
    authorize: (project: string) => Promise<void>,
    stage?: (registration: CliRegistration, apiKey: string) => Promise<void>,
  ) {
    const p = cliObject(input, ["name", "kind", "projects", "projectScope", "capabilities", "expiresInDays"]),
      name = cliText(p.name, 80);
    const projectScope = p.projectScope ?? "selected";
    const projectInput = p.projects ?? [];
    if (
      !["codex", "claude", "cli"].includes(String(p.kind)) ||
      (projectScope !== "selected" && projectScope !== "allAccessible") ||
      !Array.isArray(projectInput) ||
      (projectScope === "allAccessible"
        ? projectInput.length !== 0
        : !projectInput.length || projectInput.length > 64) ||
      !Array.isArray(p.capabilities) ||
      !p.capabilities.length ||
      p.capabilities.length > CLI_CAPABILITIES.length
    )
      throw new CliError("invalidInput");
    const projects = [...new Set(projectInput.map(cliId))],
      capabilities = [...new Set(p.capabilities)] as CliCapability[];
    if (
      capabilities.some((c) => !CLI_CAPABILITIES.includes(c)) ||
      !Number.isSafeInteger(p.expiresInDays) ||
      Number(p.expiresInDays) < 1 ||
      Number(p.expiresInDays) > 365
    )
      throw new CliError("invalidInput");
    const canonicalServer = cliServer(server);
    for (const project of projects) await authorize(project);
    const now = this.now(),
      clientId = randomUUID(),
      keyId = randomBytes(12).toString("hex"),
      apiKey = "pfk_" + keyId + "_" + randomBytes(32).toString("base64url"),
      expiresAt = now + Number(p.expiresInDays) * 86400000;
    const registration: CliRegistration = {
      schema: 1,
      protocol: 1,
      server: canonicalServer,
      clientId,
      kind: p.kind as CliClientKind,
      credentialRef: "credentials.json",
    };
    await stage?.(registration, apiKey);
    await this.store.issue(
      { id: clientId, owner, name, kind: p.kind as CliClientKind, createdAt: now, revokedAt: null },
      {
        clientId,
        keyId,
        owner,
        projects,
        projectScope,
        capabilities,
        expiresAt,
        digest: digest(apiKey),
        createdAt: now,
        revokedAt: null,
        lastUsedAt: null,
      },
    );
    return { registration, apiKey, expiresAt, projects, projectScope, capabilities };
  }
  private async verify(apiKey: unknown, matchesClient: (id: string) => boolean) {
    if (typeof apiKey !== "string" || !/^pfk_[a-f0-9]{24}_[a-zA-Z0-9_-]{43}$/.test(apiKey))
      throw new CliError("authenticationRequired", 401);
    const row = await this.store.find(apiKey.slice(4, 28)),
      actual = Buffer.from(digest(apiKey), "hex"),
      expected = Buffer.from(row?.key.digest ?? "0".repeat(64), "hex");
    if (
      !timingSafeEqual(actual, expected) ||
      !row ||
      !matchesClient(row.client.id) ||
      row.key.clientId !== row.client.id ||
      row.client.owner !== row.key.owner ||
      row.client.revokedAt !== null ||
      row.key.revokedAt !== null ||
      row.key.expiresAt <= this.now()
    )
      throw new CliError("authenticationRequired", 401);
    await this.store.touch(row.key.keyId, this.now());
    return row;
  }
  async registrationForSetup(apiKey: unknown): Promise<Pick<CliRegistration, "clientId" | "kind">> {
    const { client } = await this.verify(apiKey, () => true);
    return { clientId: client.id, kind: client.kind };
  }
  async authenticate(clientId: unknown, apiKey: unknown): Promise<CliGrant> {
    if (typeof clientId !== "string") throw new CliError("authenticationRequired", 401);
    const row = await this.verify(apiKey, (id) => id === clientId);
    const { owner, keyId, projects, projectScope, capabilities, expiresAt } = row.key;
    return {
      owner,
      keyId,
      clientId,
      projects,
      ...(projectScope === "allAccessible" ? { projectScope } : {}),
      capabilities,
      expiresAt,
    };
  }
  async list(owner: string) {
    return (await this.store.list(owner)).map(({ client, key }) => ({
      id: client.id,
      name: client.name,
      kind: client.kind,
      createdAt: client.createdAt,
      revokedAt: client.revokedAt ?? key.revokedAt,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      projects: key.projects,
      projectScope: key.projectScope ?? "selected",
      capabilities: key.capabilities,
    }));
  }
  async revoke(owner: string, clientId: unknown) {
    await this.store.revoke(owner, cliId(clientId), this.now());
  }
}
