import { createHash } from "node:crypto";
import { registeredStorageId, type RegisteredStorageConnection } from "../../shared/workspace-tools/storage.js";
import { stableJson } from "../../shared/stable-json.js";
import { CredentialCipher } from "../connections/credentials/cipher.js";
import type { SecretEnvelope } from "../connections/credentials/ports.js";
import type { OriginalStorageConfiguration, RegisteredObjectTarget } from "./configuration.js";
import { ObjectStorageError } from "./contracts.js";
import type { PrivateStorageFiles } from "./private-files.js";
import { PrivateS3Client, validateS3Connection, validateS3Credentials } from "./s3.js";
import { storageCredentials, storageInteger, storageOperationId, storageRecord } from "./config-codec.js";
import { storageSha256 } from "./sigv4.js";

export function invalidRegistration(): never {
  throw new ObjectStorageError("storageInvalidConfiguration");
}
export function registrationFields(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidRegistration();
  const value = input as Record<string, unknown>;
  const field = (name: string, limit: number, optional = false) => {
    const text = value[name] ?? "";
    if (
      typeof text !== "string" ||
      text.length > limit ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(text) ||
      (!text.trim() && !optional)
    )
      return invalidRegistration();
    return text.trim();
  };
  const id = field("id", 36),
    name = field("name", 120);
  if (!registeredStorageId.test(id)) return invalidRegistration();
  return { id, name, value, field };
}
interface RecordFile {
  schema: 1;
  connection: RegisteredStorageConnection;
  proof: string;
  secret: SecretEnvelope;
}
interface KeyVersion {
  schema: 1;
  revision: number;
  operationId: string;
  proof: string;
  secret: SecretEnvelope;
}
const keyGeneration = (revision: number) => String(storageInteger(revision, 1)).padStart(10, "0") + ".json";

export class StorageRegistration {
  readonly cipher: CredentialCipher;
  constructor(
    readonly files: PrivateStorageFiles,
    private readonly original: OriginalStorageConfiguration,
  ) {
    this.cipher = new CredentialCipher({
      load: async () => {
        const bytes = Buffer.from(await files.scope("panda-force.storage-connections.encryption.v1"), "hex");
        return { id: createHash("sha256").update(bytes).digest("hex").slice(0, 16), bytes };
      },
    });
  }

  binding(id: string, provider: string) {
    return { connectionId: id, connectorId: "storage-" + provider, ownerId: "installation" };
  }
  private path(id: string) {
    return ["registered-connections", id + ".json"];
  }
  private keyDirectory(id: string) {
    return ["registered-connection-keys", id];
  }
  private async object(id: string) {
    if (!registeredStorageId.test(id)) return invalidRegistration();
    const record = (await this.files.read(this.path(id))) as RecordFile | null;
    if (!record) return null;
    if (record.schema !== 1 || record.connection?.id !== id || !record.secret)
      throw new ObjectStorageError("storageIntegrity");
    return record.connection.provider === "google-drive"
      ? null
      : {
          ...record,
          connection: record.connection,
        };
  }
  private async currentKey(id: string, initial: SecretEnvelope) {
    const directory = this.keyDirectory(id),
      name = (await this.files.list(directory)).filter((entry) => /^\d{10}\.json$/.test(entry)).at(-1);
    if (!name) return { revision: 1, secret: initial };
    const record = (await this.files.read([...directory, name])) as KeyVersion | null;
    if (!record || record.schema !== 1 || keyGeneration(record.revision) !== name || !record.secret)
      throw new ObjectStorageError("storageIntegrity");
    return record;
  }
  async browseConnection(id: string) {
    if (!registeredStorageId.test(id)) {
      const connection = (await this.original.read()).profiles.find((profile) => profile.id === id);
      return connection
        ? { provider: "s3" as const, name: connection.label, target: await this.original.client(id) }
        : null;
    }
    const record = (await this.files.read(this.path(id))) as RecordFile | null;
    if (!record) return null;
    const { connection, secret } = record;
    if (record.schema !== 1 || connection?.id !== id || !secret) throw new ObjectStorageError("storageIntegrity");
    if (connection.provider === "google-drive")
      return {
        ...connection,
        secret: await this.cipher.open(this.binding(id, connection.provider), secret),
      };
    const target = await this.objectTarget(id);
    return target ? { provider: connection.provider, name: connection.name, target } : null;
  }

  async objectTarget(id: string): Promise<RegisteredObjectTarget | null> {
    const row = await this.object(id);
    if (!row) return null;
    const { connection } = row;
    const key = await this.currentKey(id, row.secret);
    const credentials = storageCredentials(await this.cipher.open(this.binding(id, connection.provider), key.secret));
    const { endpoint, bucket, region, prefix, forcePathStyle } = connection;
    const profile = { id, endpoint, bucket, region, prefix, forcePathStyle };
    return {
      profile,
      digest: storageSha256(stableJson(profile)),
      credentialRevision: key.revision,
      client: new PrivateS3Client(profile, credentials),
    };
  }

  async rotateObject(value: unknown) {
    const input = storageRecord(value, ["action", "id", "operationId", "credentialRevision", "credentials"]);
    const id = typeof input.id === "string" ? input.id : invalidRegistration(),
      revision = storageInteger(input.credentialRevision, 1),
      operationId = storageOperationId(input.operationId),
      credentials = storageCredentials(input.credentials),
      row = await this.object(id);
    if (!row) return invalidRegistration();
    const proof = await this.files.scope(stableJson([id, operationId, revision, credentials])),
      path = [...this.keyDirectory(id), keyGeneration(revision + 1)];
    const receipt = () => this.files.read(path) as Promise<KeyVersion | null>;
    const previous = await receipt();
    if (previous?.schema === 1 && previous.proof === proof) return;
    if (previous || (await this.currentKey(id, row.secret)).revision !== revision)
      throw new ObjectStorageError("storageConflict");
    const record: KeyVersion = {
      schema: 1,
      revision: revision + 1,
      operationId,
      proof,
      secret: await this.cipher.seal(this.binding(id, row.connection.provider), { ...credentials }),
    };
    if (!(await this.files.writeOnce(path, record)) && (await receipt())?.proof !== proof)
      throw new ObjectStorageError("storageConflict");
  }

  async list(): Promise<RegisteredStorageConnection[]> {
    const legacy = await this.original.read();
    const originals = legacy.profiles.map(
      ({
        id,
        label,
        endpoint,
        bucket,
        region,
        prefix,
        forcePathStyle,
        credentialRevision,
      }): RegisteredStorageConnection => ({
        id,
        name: label,
        endpoint,
        bucket,
        region,
        prefix,
        forcePathStyle,
        provider: "s3",
        credentialRevision,
        originalStorage: legacy.mode === "s3" && legacy.activeProfileId === id ? "active" : "retained",
      }),
    );
    const files = await this.files.list(["registered-connections"]);
    const added = await Promise.all(
      files.map(async (name) => {
        const record = (await this.files.read(["registered-connections", name])) as RecordFile | null;
        if (
          !record ||
          record.schema !== 1 ||
          !record.connection ||
          !record.secret ||
          name !== record.connection.id + ".json"
        )
          throw new ObjectStorageError("storageIntegrity");
        const connection = record.connection;
        return connection.provider === "google-drive"
          ? connection
          : {
              ...connection,
              credentialRevision: (await this.currentKey(connection.id, record.secret)).revision,
              ...(legacy.mode === "s3" && legacy.activeProfileId === connection.id
                ? { originalStorage: "active" as const }
                : {}),
            };
      }),
    );
    return [...added.sort((left, right) => left.name.localeCompare(right.name)), ...originals];
  }

  async save(connection: RegisteredStorageConnection, secret: Record<string, unknown>) {
    const path = this.path(connection.id),
      proof = await this.files.scope(JSON.stringify([connection, secret])),
      current = (await this.files.read(path)) as RecordFile | null;
    if (current) {
      if (current.schema !== 1 || current.proof !== proof) throw new ObjectStorageError("storageConflict");
      return current.connection;
    }
    const record: RecordFile = {
      schema: 1,
      connection,
      proof,
      secret: await this.cipher.seal(this.binding(connection.id, connection.provider), secret),
    };
    if (await this.files.writeOnce(path, record)) return connection;
    const winner = (await this.files.read(path)) as RecordFile | null;
    if (winner?.schema === 1 && winner.proof === proof) return winner.connection;
    throw new ObjectStorageError("storageConflict");
  }

  async addObjectStorage(input: unknown) {
    const { id, name, value, field } = registrationFields(input);
    const provider = value.provider;
    if (provider !== "s3" && provider !== "oss") return invalidRegistration();
    const bucket = field("bucket", 63),
      region = field("region", 64),
      prefix = field("prefix", 768, true),
      endpoint =
        field("endpoint", 2048, true) ||
        (provider === "oss" ? `https://s3.oss-${region}.aliyuncs.com` : `https://s3.${region}.amazonaws.com`);
    if (prefix && prefix.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")))
      return invalidRegistration();
    const connection = validateS3Connection({
      endpoint,
      region,
      bucket,
      forcePathStyle: provider === "s3" && value.forcePathStyle === true,
    });
    const sessionToken = field("sessionToken", 16384, true);
    const secret = validateS3Credentials({
      accessKeyId: field("accessKeyId", 256),
      secretAccessKey: field("secretAccessKey", 2048),
      ...(sessionToken ? { sessionToken } : {}),
    });
    return this.save({ ...connection, id, name, prefix, provider }, secret);
  }
}
