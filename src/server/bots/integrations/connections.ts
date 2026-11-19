import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { BotConnectionKind, BotConnectionView } from "../../../shared/bots/integrations.js";
import { BotError } from "../../../shared/bots/contracts.js";
import { isRecord } from "../../../shared/records.js";
import { CredentialCipher } from "../../connections/credentials/cipher.js";
import { FileCredentialKey, initializeCredentialKey } from "../../connections/credentials/file-key.js";
import type { SecretEnvelope } from "../../connections/credentials/ports.js";
import type { BotWorkspaceStorage, BotWorkspaceRecord } from "../workspace/storage.js";
import { botWorkspaceSlot } from "./quota.js";

export interface BotConnectionRecord {
  name: string;
  kind: BotConnectionKind;
  state: BotConnectionView["state"];
  envelope: SecretEnvelope;
  checkedAt: number | null;
  account?: string;
  refresh?: { id: string; expiresAt: number };
  failure?: string;
}
export function botConnectionView(row: BotWorkspaceRecord<BotConnectionRecord>): BotConnectionView {
  return {
    id: row.id,
    revision: row.version,
    name: row.data.name,
    kind: row.data.kind,
    state: row.data.state,
    checkedAt: row.data.checkedAt,
    ...(row.data.account ? { account: row.data.account } : {}),
  };
}
export function botConnectionId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new BotError("invalidConnection");
  return value;
}
function credentialText(value: unknown, maximum = 8192) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\r\n\0]/.test(value))
    throw new BotError("invalidConnection");
  return value;
}
/** User-owned connections share the Bot database; only authenticated server code can decrypt their bound secrets. */
export class BotConnections {
  readonly cipher: CredentialCipher;
  constructor(
    readonly storage: BotWorkspaceStorage,
    stateRoot: string,
    keyPath = process.env.PANDA_FORCE_BOT_CONNECTION_KEY_FILE || join(stateRoot, "config", "bot-connection-key"),
  ) {
    if (!isAbsolute(keyPath)) throw new Error("PANDA_FORCE_BOT_CONNECTION_KEY_FILE must be absolute");
    const file = new FileCredentialKey(keyPath);
    this.cipher = new CredentialCipher({
      async load() {
        try {
          await access(keyPath);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" ||
            (await storage.scan("connection", { limit: 1 })).length
          )
            throw new BotError("connectionKeyUnavailable", 503);
          await initializeCredentialKey(keyPath);
        }
        return file.load();
      },
    });
  }
  binding(owner: string, row: Pick<BotWorkspaceRecord<BotConnectionRecord>, "id" | "data">) {
    return { ownerId: owner, connectionId: row.id, connectorId: "panda-bot-" + row.data.kind };
  }
  async row(owner: string, id: string, kind?: BotConnectionKind) {
    const row = await this.storage.get<BotConnectionRecord>(owner, { kind: "connection", id: botConnectionId(id) });
    if (!row || (kind && row.data.kind !== kind)) throw new BotError("connectionNotFound", 404);
    return row;
  }
  async list(owner: string) {
    const rows = await this.storage.list<BotConnectionRecord>(owner, "connection", { limit: 101 });
    return rows.map(botConnectionView);
  }
  open(owner: string, row: BotWorkspaceRecord<BotConnectionRecord>) {
    return this.cipher.open(this.binding(owner, row), row.data.envelope);
  }
  async save(owner: string, value: unknown) {
    if (
      !isRecord(value) ||
      Object.keys(value).some((k) => !["id", "revision", "name", "kind", "credential", "enabled"].includes(k))
    )
      throw new BotError("invalidConnection");
    const id = botConnectionId(value.id),
      revision = Number(value.revision);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 120 ||
      !["slack", "gmail"].includes(String(value.kind)) ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean")
    )
      throw new BotError("invalidConnection");
    const kind = value.kind as BotConnectionKind,
      previous = await this.storage.get<BotConnectionRecord>(owner, { kind: "connection", id });
    if ((previous?.version ?? 0) !== revision) throw new BotError("staleConnection", 409);
    if (previous && previous.data.kind !== kind) throw new BotError("invalidConnection");
    const slot = previous
      ? { checks: [], puts: [] }
      : await botWorkspaceSlot(this.storage, owner, "connection", "connections");
    let envelope = previous?.data.envelope;
    if (value.credential !== undefined) {
      if (!isRecord(value.credential)) throw new BotError("invalidConnection");
      const expected = kind === "slack" ? ["token"] : ["clientId", "clientSecret", "refreshToken"];
      if (Object.keys(value.credential).some((k) => !expected.includes(k))) throw new BotError("invalidConnection");
      const credential = value.credential,
        secret = Object.fromEntries(expected.map((k) => [k, credentialText(credential[k])]));
      envelope = await this.cipher.seal({ ownerId: owner, connectionId: id, connectorId: "panda-bot-" + kind }, secret);
    }
    if (!envelope) throw new BotError("invalidConnection");
    const data: BotConnectionRecord = {
      name: value.name.trim(),
      kind,
      envelope,
      state:
        value.enabled === false
          ? "disabled"
          : value.credential || !previous || previous.state === "disabled"
            ? "unverified"
            : previous.data.state,
      checkedAt: value.credential ? null : (previous?.data.checkedAt ?? null),
      ...(value.credential ? {} : previous?.data.account ? { account: previous.data.account } : {}),
      ...(value.credential ? {} : previous?.data.refresh ? { refresh: previous.data.refresh } : {}),
      ...(value.credential ? {} : previous?.data.failure ? { failure: previous.data.failure } : {}),
    };
    if (
      !(await this.storage.batch(owner, {
        checks: [{ kind: "connection", id, version: previous?.version ?? null }, ...slot.checks],
        puts: [
          { kind: "connection", id, botId: "connections", state: data.state, dueAt: null, expiresAt: null, data },
          ...(slot.puts ?? []),
        ],
      }))
    )
      throw new BotError("staleConnection", 409);
    return botConnectionView((await this.row(owner, id))!);
  }
  async remove(owner: string, id: string) {
    const row = await this.row(owner, id);
    if (row.data.state !== "disabled") throw new BotError("disableConnectionFirst", 409);
    // Disabled records cannot acquire new verified bindings. Existing references must be removed or changed first.
    for (const kind of ["integration", "delivery"] as const) {
      let after: string | undefined;
      for (;;) {
        const page = await this.storage.list<Record<string, unknown>>(owner, kind, {
          limit: 1000,
          ...(after ? { after } : {}),
        });
        if (page.some((entry) => JSON.stringify(entry.data).includes(id))) throw new BotError("connectionInUse", 409);
        if (page.length < 1000) break;
        after = page.at(-1)!.id;
      }
    }
    const key = { kind: "control" as const, id: "connection:connections" },
      quota = await this.storage.get<{ count: number }>(owner, key);
    if (
      !(await this.storage.batch(owner, {
        checks: [
          { kind: "connection", id, version: row.version },
          { ...key, version: quota?.version ?? null },
        ],
        removes: [{ kind: "connection", id }],
        puts: [
          {
            ...key,
            botId: "connections",
            state: "quota",
            dueAt: null,
            expiresAt: null,
            data: { count: Math.max(0, (quota?.data.count ?? (await this.list(owner)).length) - 1) },
          },
        ],
      }))
    )
      throw new BotError("staleConnection", 409);
  }
  async update(owner: string, row: BotWorkspaceRecord<BotConnectionRecord>, data: BotConnectionRecord) {
    return this.storage.batch(owner, {
      checks: [{ kind: "connection", id: row.id, version: row.version }],
      puts: [
        { kind: "connection", id: row.id, botId: "connections", state: data.state, dueAt: null, expiresAt: null, data },
      ],
    });
  }
}
