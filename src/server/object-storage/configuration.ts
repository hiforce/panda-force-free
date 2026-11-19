import type { CreativeAssetKind } from "../../shared/creative/assets.js";
import type {
  OriginalStorageCredentials,
  OriginalStorageSettings,
  OriginalStorageMutation,
  OriginalStorageOperation,
} from "../../shared/storage/contracts.js";
import { stableJson } from "../../shared/stable-json.js";
import { ObjectStorageError } from "./contracts.js";
import { PrivateStorageFiles } from "./private-files.js";
import { PrivateS3Client } from "./s3.js";
import { storageSha256 } from "./sigv4.js";
import {
  storageMutation,
  storageConfigurationRecord,
  storedStorageProfile,
  storageRecord,
  storageOperationId,
  storageProfileId,
  storageInteger,
  storageDigest,
  storageCredentials,
  type StoredStorageProfile,
  type StorageConfigurationRecord,
  type StorageProfileReference,
} from "./config-codec.js";

const generation = (revision: number) => String(storageInteger(revision, 1)).padStart(10, "0") + ".json";
const integrity = (): never => {
  throw new ObjectStorageError("storageIntegrity");
};
const conflict = (): never => {
  throw new ObjectStorageError("storageConflict");
};
const initial = (): StorageConfigurationRecord => ({
  schema: 1,
  revision: 0,
  operationId: null,
  signature: null,
  mode: "local",
  kinds: ["image", "video"],
  activeProfileId: null,
  profiles: [],
});
const operationPath = (id: string, saved = false) => [
  "configuration-operations",
  id.slice(0, 2),
  id + (saved ? ".saved.json" : ".json"),
];
const profileIdentity = (
  p: Omit<StoredStorageProfile, "schema" | "id" | "createdAt" | "operationId" | "signature">,
) => ({
  endpoint: p.endpoint,
  region: p.region,
  bucket: p.bucket,
  prefix: p.prefix,
  forcePathStyle: p.forcePathStyle,
  label: p.label,
});

/** Configuration activates an immutable provider and separate credential generation in one CAS publication. */
export class OriginalStorageConfiguration {
  constructor(readonly files: PrivateStorageFiles) {}
  private async current(): Promise<StorageConfigurationRecord> {
    const names = (await this.files.list(["config"])).filter((name) => /^\d{10}\.json$/.test(name));
    if (!names.length) return initial();
    const name = names.at(-1)!,
      value = storageConfigurationRecord(await this.files.read(["config", name]));
    if (generation(value.revision) !== name) return integrity();
    return value;
  }
  private async profile(reference: StorageProfileReference) {
    const profile = storedStorageProfile(await this.files.read(["profiles", reference.id + ".json"]));
    if (profile.id !== reference.id || storageSha256(stableJson(profile)) !== reference.digest) return integrity();
    return profile;
  }
  private async secret(reference: StorageProfileReference) {
    const value = storageRecord(
      await this.files.read(["credentials", reference.id, reference.credentialId + ".json"]),
      ["schema", "profileId", "id", "revision", "requestSignature", "credentials", "signature"],
    );
    if (
      value.schema !== 1 ||
      storageProfileId(value.profileId) !== reference.id ||
      storageOperationId(value.id) !== reference.credentialId ||
      storageInteger(value.revision, 1) !== reference.credentialRevision
    )
      return integrity();
    const credentials = storageCredentials(value.credentials),
      content = {
        schema: 1,
        profileId: reference.id,
        id: reference.credentialId,
        revision: reference.credentialRevision,
        requestSignature: storageDigest(value.requestSignature),
        credentials,
      };
    if (
      (await this.files.scope(stableJson(content))) !== value.signature ||
      credentials.accessKeyId.slice(-4) !== reference.accessKeyHint
    )
      return integrity();
    return credentials;
  }
  private async view(record: StorageConfigurationRecord): Promise<OriginalStorageSettings> {
    const profiles: OriginalStorageSettings["profiles"] = [];
    for (const reference of record.profiles) {
      const profile = await this.profile(reference);
      profiles.push({
        ...profileIdentity(profile),
        id: profile.id,
        credentialRevision: reference.credentialRevision,
        accessKeyHint: reference.accessKeyHint,
      });
    }
    return {
      schema: 1,
      revision: record.revision,
      mode: record.mode,
      kinds: record.kinds,
      activeProfileId: record.activeProfileId,
      operationId: record.operationId,
      profiles,
    };
  }
  async read() {
    return this.view(await this.current());
  }
  private async result(savedRevision: number) {
    const settings = await this.read();
    if (settings.revision < savedRevision) return integrity();
    return { savedRevision, settings };
  }
  private operationRecord(value: unknown) {
    const record = storageRecord(value, ["schema", "operationId", "revision", "signature"]);
    if (record.schema !== 1) return integrity();
    return {
      schema: 1 as const,
      operationId: storageOperationId(record.operationId),
      revision: storageInteger(record.revision),
      signature: storageDigest(record.signature),
    };
  }
  private async completed(input: { operationId: string; revision: number }, signature: string) {
    const value = { schema: 1, operationId: input.operationId, revision: input.revision + 1, signature };
    if (
      !(await this.files.writeOnce(operationPath(input.operationId, true), value)) &&
      stableJson(await this.files.read(operationPath(input.operationId, true))) !== stableJson(value)
    )
      return integrity();
  }
  async operation(value: string): Promise<OriginalStorageOperation | null> {
    const id = storageOperationId(value),
      raw = await this.files.read(operationPath(id));
    if (raw === null) return null;
    const intent = this.operationRecord(raw),
      current = await this.current();
    if (intent.operationId !== id) return integrity();
    let saved = await this.files.read(operationPath(id, true));
    if (saved === null) {
      const candidate = await this.files.read(["config", generation(intent.revision + 1)]);
      if (candidate !== null) {
        const record = storageConfigurationRecord(candidate);
        if (record.operationId === id && record.signature === intent.signature) {
          await this.completed(intent, intent.signature);
          saved = await this.files.read(operationPath(id, true));
        }
      }
    }
    if (saved !== null) {
      const receipt = this.operationRecord(saved);
      if (
        receipt.operationId !== id ||
        receipt.signature !== intent.signature ||
        receipt.revision !== intent.revision + 1
      )
        return integrity();
      const observed = await this.current();
      if (observed.revision < receipt.revision) return integrity();
      return { id, state: "saved", savedRevision: receipt.revision, currentRevision: observed.revision };
    }
    return {
      id,
      state: current.revision > intent.revision ? "not-saved" : "pending",
      savedRevision: null,
      currentRevision: current.revision,
    };
  }
  private async prepareSecret(
    profile: { id: string; digest: string },
    revision: number,
    input: OriginalStorageMutation,
    credentials: OriginalStorageCredentials,
    signature: string,
  ): Promise<StorageProfileReference> {
    const content = {
        schema: 1,
        profileId: profile.id,
        id: input.operationId,
        revision,
        requestSignature: signature,
        credentials,
      },
      record = { ...content, signature: await this.files.scope(stableJson(content)) },
      path = ["credentials", profile.id, input.operationId + ".json"];
    if (!(await this.files.writeOnce(path, record))) {
      const previous = await this.files.read(path);
      if (stableJson(previous) !== stableJson(record)) return conflict();
    }
    return {
      ...profile,
      credentialId: input.operationId,
      credentialRevision: revision,
      accessKeyHint: credentials.accessKeyId.slice(-4),
    };
  }
  private async prepareProfile(
    input: Extract<OriginalStorageMutation, { action: "configure" }>,
    current: StorageConfigurationRecord,
    signature: string,
  ) {
    const requested = input.profile!;
    const old = requested.id ? current.profiles.find((value) => value.id === requested.id) : undefined;
    if (requested.id && !old) return conflict();
    const previous = old ? await this.profile(old) : undefined,
      unchanged = previous && stableJson(profileIdentity(previous)) === stableJson(profileIdentity(requested));
    if (old && unchanged) {
      return requested.credentials
        ? this.prepareSecret(old, old.credentialRevision + 1, input, requested.credentials, signature)
        : old;
    }
    // A new endpoint never receives a kept secret from the old connection without an explicit new credential input.
    if (!requested.credentials && (!old || !previous || requested.endpoint !== previous.endpoint))
      throw new ObjectStorageError("storageInvalidConfiguration");
    const credentials = requested.credentials ?? (await this.secret(old!)),
      id = "s-" + (await this.files.scope("profile:" + input.operationId)).slice(0, 40),
      path = ["profiles", id + ".json"];
    let profile: StoredStorageProfile = {
      schema: 1,
      id,
      ...profileIdentity(requested),
      createdAt: Date.now(),
      operationId: input.operationId,
      signature,
    };
    if (!(await this.files.writeOnce(path, profile))) {
      const existing = storedStorageProfile(await this.files.read(path));
      if (
        existing.id !== id ||
        existing.operationId !== input.operationId ||
        existing.signature !== signature ||
        stableJson(profileIdentity(existing)) !== stableJson(profileIdentity(requested))
      )
        return conflict();
      profile = existing;
    }
    return this.prepareSecret({ id, digest: storageSha256(stableJson(profile)) }, 1, input, credentials, signature);
  }
  async save(value: unknown) {
    const input = storageMutation(value),
      signature = await this.files.scope(stableJson(input)),
      intent = { schema: 1, operationId: input.operationId, revision: input.revision, signature },
      intentPath = operationPath(input.operationId);
    if (
      !(await this.files.writeOnce(intentPath, intent)) &&
      stableJson(await this.files.read(intentPath)) !== stableJson(intent)
    )
      return conflict();
    const receipt = await this.files.read(operationPath(input.operationId, true));
    if (receipt !== null) {
      const previous = this.operationRecord(receipt);
      if (
        previous.operationId !== input.operationId ||
        previous.signature !== signature ||
        previous.revision !== input.revision + 1
      )
        return integrity();
      return this.result(previous.revision);
    }
    const previousResult = await this.files.read(["config", generation(input.revision + 1)]);
    if (previousResult !== null) {
      const saved = storageConfigurationRecord(previousResult);
      if (saved.operationId !== input.operationId || saved.signature !== signature) return conflict();
      await this.completed(input, signature);
      return this.result(saved.revision);
    }
    const current = await this.current();
    if (current.revision !== input.revision) return conflict();
    const next: StorageConfigurationRecord = {
      ...current,
      profiles: [...current.profiles],
      revision: current.revision + 1,
      operationId: input.operationId,
      signature,
    };
    let reference: StorageProfileReference | undefined;
    if (input.action === "credentials") {
      const old = current.profiles.find((profile) => profile.id === input.profileId);
      if (!old || old.credentialRevision !== input.credentialRevision) return conflict();
      reference = await this.prepareSecret(old, old.credentialRevision + 1, input, input.credentials, signature);
    } else {
      next.mode = input.mode;
      next.kinds = input.kinds;
      if (input.profile) {
        reference = await this.prepareProfile(input, current, signature);
        next.activeProfileId = reference.id;
      }
      if (next.mode === "s3" && !next.activeProfileId) throw new ObjectStorageError("storageInvalidConfiguration");
    }
    if (reference) {
      const at = next.profiles.findIndex((profile) => profile.id === reference.id);
      if (at < 0) next.profiles.push(reference);
      else next.profiles[at] = reference;
    }
    if (next.profiles.length > 128) throw new ObjectStorageError("storageTooLarge");
    const validated = storageConfigurationRecord(next);
    if (!(await this.files.writeOnce(["config", generation(next.revision)], validated))) {
      const saved = storageConfigurationRecord(await this.files.read(["config", generation(next.revision)]));
      if (saved.operationId !== input.operationId || saved.signature !== signature) return conflict();
    }
    await this.completed(input, signature);
    return this.result(next.revision);
  }
  async client(profileId: string, expectedDigest?: string) {
    storageProfileId(profileId);
    const current = await this.current(),
      reference = current.profiles.find((profile) => profile.id === profileId);
    if (!reference || (expectedDigest !== undefined && reference.digest !== expectedDigest)) return integrity();
    const profile = await this.profile(reference),
      credentials = await this.secret(reference);
    return {
      profile,
      digest: reference.digest,
      credentialRevision: reference.credentialRevision,
      client: new PrivateS3Client(profile, credentials),
    };
  }
  async writeTarget(kind: CreativeAssetKind) {
    const current = await this.current();
    if (current.mode !== "s3" || !current.kinds.includes(kind)) return null;
    const reference = current.profiles.find((profile) => profile.id === current.activeProfileId);
    if (!reference) return integrity();
    const profile = await this.profile(reference),
      credentials = await this.secret(reference);
    return { profile, digest: reference.digest, client: new PrivateS3Client(profile, credentials) };
  }
}
