import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CreationMediaCredential } from "../../../../shared/creation/media-executors.js";
import type { CredentialCipher } from "../../../connections/credentials/cipher.js";
import { MediaExecutorError } from "../../media-executors/contracts.js";

type StoredCredential = CreationMediaCredential & { keyRevision: number; envelope: string | null };
type CredentialInput = Pick<CreationMediaCredential, "id" | "name" | "target" | "revision" | "baseUrl"> & {
  apiKey?: string;
};

export function executorApiKey(value: string) {
  const key = value.trim();
  if (!/^[\x21-\x7e]+$/.test(key)) throw new MediaExecutorError("invalidInput");
  return key;
}

function projection({ id, name, target, revision, baseUrl }: StoredCredential): CreationMediaCredential {
  return { id, name, target, revision, ...(baseUrl ? { baseUrl } : {}) };
}

/** Only the private media worker opens ciphertext. References can be shared by many executors. */
export class MediaCredentials {
  private readonly database: Database;
  constructor(
    root: string,
    private readonly cipher: CredentialCipher,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.database = new Database(join(root, "credentials.sqlite"), { strict: true });
    this.database.exec(`PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS credentials (
        owner TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL, baseUrl TEXT,
        revision INTEGER NOT NULL, keyRevision INTEGER NOT NULL, envelope TEXT, PRIMARY KEY(owner,id)
      );`);
  }

  count() {
    return this.database
      .query<{ total: number }, []>("SELECT count(*) AS total FROM credentials WHERE envelope IS NOT NULL")
      .get()!.total;
  }

  private find(owner: string, id: string) {
    return this.database
      .query<StoredCredential, [string, string]>(
        "SELECT id,name,target,baseUrl,revision,keyRevision,envelope FROM credentials WHERE owner=? AND id=?",
      )
      .get(owner, id);
  }

  private binding(owner: string, id: string, target: string) {
    return {
      ownerId: owner,
      connectionId: id,
      connectorId: "exec-key." + createHash("sha256").update(target).digest("hex").slice(0, 50),
    };
  }

  list(owner: string) {
    return this.database
      .query<StoredCredential, [string]>(
        "SELECT id,name,target,baseUrl,revision,keyRevision,NULL AS envelope FROM credentials WHERE owner=? AND envelope IS NOT NULL ORDER BY name COLLATE NOCASE,id",
      )
      .all(owner)
      .map(projection);
  }

  metadata(owner: string, id: string, target: string) {
    const row = this.find(owner, id);
    if (!row?.envelope || row.target !== target) throw new MediaExecutorError("notFound");
    return { ...projection(row), keyRevision: row.keyRevision };
  }

  async resolve(owner: string, id: string, target: string) {
    const row = this.find(owner, id);
    if (!row?.envelope || row.target !== target) throw new MediaExecutorError("notFound");
    const { apiKey, baseUrl } = await this.cipher.open(this.binding(owner, id, target), JSON.parse(row.envelope));
    if (typeof apiKey !== "string" || baseUrl !== (row.baseUrl ?? null)) throw new MediaExecutorError("authentication");
    return { ...projection(row), apiKey, keyRevision: row.keyRevision };
  }

  async save(owner: string, input: CredentialInput) {
    const { id, name, target, baseUrl, revision, apiKey } = input;
    const current = this.find(owner, id);
    if (current && (!current.envelope || current.target !== target)) throw new MediaExecutorError("conflict");
    const binding = this.binding(owner, id, target);
    // Retries after a lost response can acknowledge the existing write.
    if (
      current &&
      current.revision === revision + 1 &&
      current.name === name &&
      (current.baseUrl ?? undefined) === baseUrl
    ) {
      const matches = !apiKey || (await this.cipher.open(binding, JSON.parse(current.envelope!))).apiKey === apiKey;
      if (!matches) throw new MediaExecutorError("conflict");
      if (this.find(owner, id)?.revision !== current.revision) throw new MediaExecutorError("conflict");
      return projection(current);
    }
    if ((current?.revision ?? 0) !== revision) throw new MediaExecutorError("conflict");
    if (!apiKey && (!current || (current.baseUrl ?? undefined) !== baseUrl))
      throw new MediaExecutorError("invalidInput");
    const envelope = apiKey
      ? JSON.stringify(await this.cipher.seal(binding, { apiKey, baseUrl: baseUrl ?? null }))
      : current!.envelope!;
    const keyRevision = (current?.keyRevision ?? 0) + (apiKey ? 1 : 0);
    const result = current
      ? this.database.run(
          "UPDATE credentials SET name=?,baseUrl=?,revision=?,keyRevision=?,envelope=? WHERE owner=? AND id=? AND revision=? AND envelope IS NOT NULL",
          [name, baseUrl ?? null, revision + 1, keyRevision, envelope, owner, id, revision],
        )
      : this.database.run("INSERT OR IGNORE INTO credentials VALUES (?,?,?,?,?,?,?,?)", [
          owner,
          id,
          name,
          target,
          baseUrl ?? null,
          revision + 1,
          keyRevision,
          envelope,
        ]);
    if (result.changes !== 1) throw new MediaExecutorError("conflict");
    return projection({ id, name, target, baseUrl, revision: revision + 1, keyRevision, envelope });
  }

  remove(owner: string, id: string, revision: number) {
    const result = this.database.run(
      "UPDATE credentials SET revision=revision+1,keyRevision=keyRevision+1,envelope=NULL WHERE owner=? AND id=? AND revision=? AND envelope IS NOT NULL",
      [owner, id, revision],
    );
    if (result.changes === 1) return;
    const current = this.find(owner, id);
    if (!current) throw new MediaExecutorError("notFound");
    if (!current.envelope && current.revision === revision + 1) return;
    throw new MediaExecutorError("conflict");
  }
}
