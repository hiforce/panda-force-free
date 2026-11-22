import { Database } from "bun:sqlite";
import { access } from "node:fs/promises";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { sftpCredential, sftpHostKey } from "../connections/adapters/sftp-input.js";
import { CredentialCipher } from "../connections/credentials/cipher.js";
import { FileCredentialKey, initializeCredentialKey } from "../connections/credentials/file-key.js";
import type { SecretEnvelope } from "../connections/credentials/ports.js";
import { ConnectionError } from "../connections/errors.js";
import { connectionId, connectionText } from "../connections/validation.js";
import type { RemoteConnection } from "../../shared/workspace-tools/remote.js";
import { RemoteError } from "./errors.js";
import { remoteHost } from "./host-key.js";

type Stored = { data: string; credential: string; operation: string };
const profileKeys = new Set([
  "id",
  "version",
  "name",
  "host",
  "port",
  "username",
  "hostKey",
  "credential",
  "operationId",
]);
const binding = (ownerId: string, connectionId: string) => ({ ownerId, connectionId, connectorId: "remote-ssh" });

export function remoteId(value: unknown) {
  try {
    return connectionId(value);
  } catch {
    throw new RemoteError("invalidInput");
  }
}
function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RemoteError("invalidInput");
  return value;
}
function endpoint(input: Record<string, unknown>) {
  if (Object.keys(input).some((key) => !profileKeys.has(key))) throw new RemoteError("invalidInput");
  try {
    const name = connectionText(input.name, 120);
    const target = remoteHost(input);
    const username = connectionText(input.username, 64);
    const hostKey = sftpHostKey(input.hostKey);
    if (!/^[\w][\w.-]*$/.test(username)) throw new RemoteError("invalidInput");
    return { name, ...target, username, hostKey };
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    throw new RemoteError(
      error instanceof ConnectionError && error.code === "invalidHostKey" ? "invalidHostKey" : "invalidInput",
    );
  }
}
function credential(value: unknown) {
  try {
    return sftpCredential(value);
  } catch {
    throw new RemoteError("invalidCredential");
  }
}

/** Connection metadata and its encrypted secret update in one owner-scoped transaction. */
export class RemoteRegistry {
  private database?: Database;
  private readonly path: string;
  private readonly cipher: CredentialCipher;

  constructor(stateRoot: string, keyPath = process.env.PANDA_FORCE_REMOTE_KEY_FILE) {
    this.path = join(stateRoot, "data", "remote-terminals.sqlite");
    const key = keyPath || join(stateRoot, "config", "remote-terminal-key");
    if (!isAbsolute(key)) throw new Error("PANDA_FORCE_REMOTE_KEY_FILE must be an absolute path");
    const file = new FileCredentialKey(key);
    this.cipher = new CredentialCipher({
      load: async () => {
        try {
          await access(key);
        } catch (error) {
          if (
            keyPath ||
            (error as NodeJS.ErrnoException).code !== "ENOENT" ||
            this.db.query("SELECT 1 FROM remote_connections LIMIT 1").get()
          )
            throw new RemoteError("unavailable");
          await initializeCredentialKey(key);
        }
        return file.load();
      },
    });
  }
  private get db() {
    if (this.database) return this.database;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS remote_connections (
          owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
          credential TEXT NOT NULL, operation TEXT NOT NULL,
          PRIMARY KEY (owner,id)
        );`);
      this.database = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private row(owner: string, id: string): Stored | null {
    return this.db
      .query<Stored, [string, string]>(
        "SELECT data,credential,operation FROM remote_connections WHERE owner=? AND id=?",
      )
      .get(owner, id);
  }
  list(owner: string) {
    const rows = this.db
      .query<{ data: string }, [string]>("SELECT data FROM remote_connections WHERE owner=? ORDER BY version DESC, id")
      .all(owner);
    return rows.map(({ data }) => JSON.parse(data) as RemoteConnection).sort((a, b) => a.name.localeCompare(b.name));
  }
  detail(owner: string, id: string) {
    const stored = this.row(owner, id);
    if (!stored) throw new RemoteError("notFound");
    return JSON.parse(stored.data) as RemoteConnection;
  }
  async connection(owner: string, id: string) {
    const stored = this.row(owner, id);
    if (!stored) throw new RemoteError("notFound");
    const profile = JSON.parse(stored.data) as RemoteConnection;
    const secret = await this.cipher.open(binding(owner, id), JSON.parse(stored.credential) as SecretEnvelope);
    const current = this.detail(owner, id);
    if (current.version !== profile.version) throw new RemoteError("conflict");
    return { profile, secret };
  }
  async save(owner: string, input: Record<string, unknown>) {
    const id = remoteId(input.id),
      operation = remoteId(input.operationId),
      expected = version(input.version),
      next = endpoint(input);
    const row = this.row(owner, id);
    const previous = row && (JSON.parse(row.data) as RemoteConnection);
    if (row?.operation === operation && previous?.version === expected + 1)
      return { connection: previous, replayed: true };
    const secret = input.credential === undefined ? null : credential(input.credential);
    if ((previous?.version ?? 0) !== expected) throw new RemoteError("conflict");
    if (
      !secret &&
      (!previous || (["host", "port", "username", "hostKey"] as const).some((key) => previous[key] !== next[key]))
    )
      throw new RemoteError("missingCredential");
    const method = (secret?.method || previous!.method) as RemoteConnection["method"];
    const saved = { id, version: expected + 1, ...next, method };
    const envelope = secret ? JSON.stringify(await this.cipher.seal(binding(owner, id), secret)) : row!.credential;
    return this.db
      .transaction(() => {
        if (expected === 0) {
          const { count } = this.db
            .query<{ count: number }, [string]>("SELECT count(*) count FROM remote_connections WHERE owner=?")
            .get(owner)!;
          if (count >= 200) throw new RemoteError("limit");
        }
        const result =
          expected === 0
            ? this.db
                .query(
                  "INSERT OR IGNORE INTO remote_connections(owner,id,version,data,credential,operation) VALUES (?,?,?,?,?,?)",
                )
                .run(owner, id, saved.version, JSON.stringify(saved), envelope, operation)
            : this.db
                .query(
                  "UPDATE remote_connections SET version=?,data=?,credential=?,operation=? WHERE owner=? AND id=? AND version=?",
                )
                .run(saved.version, JSON.stringify(saved), envelope, operation, owner, id, expected);
        if (result.changes !== 1) {
          const current = this.row(owner, id);
          if (current?.operation === operation)
            return { connection: JSON.parse(current.data) as RemoteConnection, replayed: true };
          throw new RemoteError("conflict");
        }
        return { connection: saved, replayed: false };
      })
      .immediate();
  }
  remove(owner: string, id: string, expected: unknown) {
    const result = this.db
      .query("DELETE FROM remote_connections WHERE owner=? AND id=? AND version=?")
      .run(owner, id, version(expected));
    if (!result.changes) {
      if (!this.row(owner, id)) throw new RemoteError("notFound");
      throw new RemoteError("conflict");
    }
  }
  close() {
    this.database?.close();
    this.database = undefined;
  }
}
