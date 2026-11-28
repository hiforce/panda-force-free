import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { executorCredentialTarget, isExecutorKind } from "../../../../shared/creation/media-executors.js";
import type {
  CreationMediaBinding,
  CreationMediaChoice,
  CreationMediaExecutor,
  CreationMediaPreset,
} from "../../../../shared/creation/media-executors.js";
import { isRecord } from "../../../../shared/records.js";
import { CredentialCipher } from "../../../connections/credentials/cipher.js";
import type { SecretEnvelope } from "../../../connections/credentials/ports.js";
import { connectionKey } from "../../../connections/integration/key-provider.js";
import { FilePackageContent } from "../../../packages/content-store.js";
import { validateCreativeMedia } from "../../../creative/assets/media.js";
import { creationInteger, creationRecord, creationText, creationUuid } from "../../validation.js";
import { mediaApiProvider } from "./api-provider.js";
import { executorApiKey, MediaCredentials } from "./credentials.js";
import { MediaCliRegistry } from "./cli-registry.js";
import { decodedImage } from "../rendering/image-result.js";
import {
  MediaExecutorError,
  type MediaPoll,
  type MediaProvider,
  type MediaRequest,
} from "../../media-executors/contracts.js";
import { apiMediaPresets, type ApiMediaPreset } from "./presets.js";

type StoredExecutor = Omit<CreationMediaExecutor, "model" | "credentialId" | "credentialUnavailable"> & {
  enabled: boolean;
  baseUrl: string;
  envelope: SecretEnvelope;
};
type ExternalChoice = Extract<CreationMediaChoice, { source: "executor" }>;
type ExternalBinding = Extract<CreationMediaBinding, { source: "executor" }>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function presetRecord(preset: ApiMediaPreset): CreationMediaPreset {
  const { id, version, name, kind, provider, transport, fixedEndpoint, models } = preset;
  return { id, version, name, kind, provider, transport, fixedEndpoint, models };
}
function executorRecord(executor: StoredExecutor, model?: string, credentialId?: string): CreationMediaExecutor {
  const { id, name, preset, presetVersion, kind, revision, status } = executor;
  return {
    id,
    name,
    preset,
    presetVersion,
    kind,
    ...(model ? { model } : {}),
    ...(credentialId ? { credentialId } : {}),
    revision,
    status,
  };
}
function parseStored(value: unknown): StoredExecutor {
  const row = creationRecord(value, [
    "id",
    "name",
    "preset",
    "presetVersion",
    "kind",
    "revision",
    "status",
    "enabled",
    "baseUrl",
    "envelope",
  ]);
  if (
    !isExecutorKind(row.kind) ||
    (row.status !== "connected" && row.status !== "unverified") ||
    typeof row.enabled !== "boolean" ||
    !isRecord(row.envelope) ||
    row.envelope.version !== 1
  )
    throw new MediaExecutorError("invalidResult");
  return {
    id: creationUuid(row.id),
    name: creationText(row.name, 80),
    preset: creationText(row.preset, 64),
    presetVersion: creationInteger(row.presetVersion),
    kind: row.kind,
    revision: creationInteger(row.revision),
    status: row.status,
    enabled: row.enabled,
    baseUrl: creationText(row.baseUrl, 2048),
    envelope: {
      version: 1,
      keyId: creationText(row.envelope.keyId, 128),
      nonce: creationText(row.envelope.nonce, 128),
      tag: creationText(row.envelope.tag, 128),
      ciphertext: creationText(row.envelope.ciphertext, 32768),
    },
  };
}

function normalizeBaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
      throw new MediaExecutorError("invalidInput");
    return url.href.replace(/\/$/, "");
  } catch {
    throw new MediaExecutorError("invalidInput");
  }
}

function configuredEndpoints(env: NodeJS.ProcessEnv, presets: readonly ApiMediaPreset[]) {
  const raw: unknown = JSON.parse(env.PANDA_FORCE_MEDIA_EXECUTOR_ENDPOINTS || "{}");
  if (!isRecord(raw)) throw new MediaExecutorError("invalidInput");
  const defaults = new Map(presets.map((preset) => [preset.id, new Set([normalizeBaseUrl(preset.baseUrl)])]));
  for (const [id, urls] of Object.entries(raw)) {
    const endpoints = defaults.get(id);
    if (
      !endpoints ||
      presets.find((preset) => preset.id === id)?.fixedEndpoint ||
      !Array.isArray(urls) ||
      urls.length > 8
    )
      throw new MediaExecutorError("invalidInput");
    for (const value of urls) endpoints.add(normalizeBaseUrl(creationText(value, 2048)));
  }
  return defaults;
}

/** Each owner has private immutable revisions. A revision is published only after its credential is sealed. */
export class CreationMediaExecutors {
  private readonly storageRoot: string;
  private readonly configurationRoot: string;
  private readonly cipher: CredentialCipher;
  private readonly sharedCredentials: MediaCredentials;
  private readonly presets: readonly ApiMediaPreset[];
  private readonly providers: ReadonlyMap<string, MediaProvider>;
  private readonly cliRegistry: MediaCliRegistry;
  private readonly cliVerifiers: ReadonlyMap<string, (signal: AbortSignal) => Promise<void>>;
  private readonly endpoints: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(stateRoot: string, env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
    const root = join(stateRoot, "creation-media");
    this.storageRoot = join(root, "owners");
    // Older releases can still open the image/video store after a rollback.
    this.configurationRoot = join(root, "configuration-owners");
    const key = connectionKey(
      root,
      {
        count: () =>
          this.sharedCredentials.count() +
          [this.storageRoot, this.configurationRoot].reduce(
            (count, directory) => count + (existsSync(directory) ? readdirSync(directory).length : 0),
            0,
          ),
      },
      { PANDA_FORCE_CONNECTION_KEY_FILE: env.PANDA_FORCE_MEDIA_EXECUTOR_KEY_FILE },
    );
    this.cipher = new CredentialCipher(key.provider);
    this.sharedCredentials = new MediaCredentials(root, this.cipher);
    this.cliRegistry = new MediaCliRegistry(root, env);
    const cli = this.cliRegistry.packages;
    this.presets = [...apiMediaPresets, ...cli.map(({ preset }) => preset)];
    if (new Set(this.presets.map(({ id }) => id)).size !== this.presets.length)
      throw new MediaExecutorError("invalidInput");
    this.providers = new Map([
      ...apiMediaPresets.map((preset) => [preset.id, mediaApiProvider(preset, send)] as const),
      ...cli.map(({ preset, provider }) => [preset.id, provider] as const),
    ]);
    this.cliVerifiers = new Map(cli.map(({ preset, provider }) => [preset.id, provider.verify]));
    this.endpoints = configuredEndpoints(env, this.presets);
  }

  private ownerRoot(owner: string, storageRoot: string) {
    return join(storageRoot, hash(creationText(owner, 200)));
  }

  private credentials(owner: string, executor: StoredExecutor) {
    return this.cipher.open(
      { ownerId: owner, connectionId: executor.id, connectorId: executor.preset },
      executor.envelope,
    );
  }

  private records(root: string) {
    return new FilePackageContent<StoredExecutor>(root, {
      maxBytes: 46000,
      encode: async (value) => Buffer.from(JSON.stringify(parseStored(value))),
      decode: async (value) => parseStored(JSON.parse(Buffer.from(value).toString("utf8"))),
      digest: (value) => hash(String(value.revision)),
    });
  }

  private confirmations(root: string, createDirectory: boolean, keyRevision?: number) {
    return new FilePackageContent<number>(
      join(root, "verified"),
      {
        maxBytes: 32,
        encode: async (revision) => Buffer.from(String(revision)),
        decode: async (bytes) => creationInteger(JSON.parse(Buffer.from(bytes).toString("utf8"))),
        digest: (revision) => hash(keyRevision === undefined ? String(revision) : revision + ":" + keyRevision),
      },
      { createDirectory },
    );
  }

  private async isConfirmed(root: string, revision: number, keyRevision?: number) {
    return (
      (await this.confirmations(root, false, keyRevision)
        .read(hash(keyRevision === undefined ? String(revision) : revision + ":" + keyRevision))
        .catch(() => null)) === revision
    );
  }

  private async view(owner: string, root: string, value: StoredExecutor) {
    const credential = await this.credentials(owner, value).catch(() => undefined);
    const model = typeof credential?.model === "string" ? credential.model : undefined;
    const credentialId = typeof credential?.credentialId === "string" ? credential.credentialId : undefined;
    const executor = executorRecord(value, model, credentialId);
    let keyRevision: number | undefined;
    if (credentialId) {
      try {
        const preset = this.preset(value.preset, value.presetVersion);
        const active = this.sharedCredentials.metadata(owner, credentialId, executorCredentialTarget(preset));
        this.endpoint(preset, active.baseUrl);
        keyRevision = active.keyRevision;
        if (keyRevision !== credential?.keyRevision) executor.status = "unverified";
      } catch {
        executor.credentialUnavailable = true;
      }
    }
    if (
      !executor.credentialUnavailable &&
      executor.status === "unverified" &&
      (await this.isConfirmed(root, value.revision, keyRevision))
    )
      executor.status = "connected";
    return executor;
  }

  private async confirm(root: string, value: StoredExecutor, result: MediaPoll, keyRevision?: number) {
    if (result.state !== "succeeded") return;
    try {
      if (value.kind === "image") await decodedImage(result.bytes);
      else await validateCreativeMedia("video", "generated.mp4", result.bytes);
    } catch {
      throw new MediaExecutorError("invalidResult");
    }
    if (value.status !== "unverified" && keyRevision === undefined) return;
    // A connection status write must not lose an original the provider already returned.
    try {
      if (!(await this.isConfirmed(root, value.revision, keyRevision)))
        await this.confirmations(root, true, keyRevision).put(value.revision);
    } catch {}
  }

  private async newestIn(owner: string, id: string, storageRoot: string) {
    const root = join(this.ownerRoot(owner, storageRoot), creationUuid(id));
    const files = await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records = this.records(root);
    const revisions = await Promise.all(
      files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => records.read(name.slice(0, -5))),
    );
    if (revisions.some((value) => value.id !== id)) throw new MediaExecutorError("invalidResult");
    return {
      root,
      value: revisions.reduce<StoredExecutor | undefined>(
        (latest, current) => (!latest || current.revision > latest.revision ? current : latest),
        undefined,
      ),
    };
  }

  private async newest(owner: string, id: string, preferred = this.storageRoot) {
    const [media, configuration] = await Promise.all([
      this.newestIn(owner, id, this.storageRoot),
      this.newestIn(owner, id, this.configurationRoot),
    ]);
    if (media.value && configuration.value) throw new MediaExecutorError("invalidResult");
    if (media.value || configuration.value) return media.value ? media : configuration;
    return preferred === this.storageRoot ? media : configuration;
  }

  private async reserveStore(owner: string, id: string, preferred: string) {
    const digest = hash("executor-store");
    const store = preferred === this.storageRoot ? "media" : "configuration";
    const receipts = new FilePackageContent<typeof store>(join(this.ownerRoot(owner, this.storageRoot), id, "store"), {
      maxBytes: 16,
      encode: async (value) => Buffer.from(value),
      decode: async (bytes) => {
        const value = Buffer.from(bytes).toString("utf8");
        if (value !== "media" && value !== "configuration") throw new MediaExecutorError("invalidResult");
        return value;
      },
      digest: () => digest,
    });
    if (!(await receipts.insert(store)) && (await receipts.read(digest)) !== store)
      throw new MediaExecutorError("conflict");
  }

  private preset(id: string, version?: number) {
    const preset = this.presets.find(
      (entry) => entry.id === id && (version === undefined || entry.version === version),
    );
    if (!preset) throw new MediaExecutorError("notFound");
    return preset;
  }

  private endpoint(preset: ApiMediaPreset, value: unknown) {
    const baseUrl =
      value === undefined || value === ""
        ? normalizeBaseUrl(preset.baseUrl)
        : normalizeBaseUrl(creationText(value, 2048));
    if (!this.endpoints.get(preset.id)?.has(baseUrl)) throw new MediaExecutorError("invalidInput");
    return baseUrl;
  }

  async cliCatalog() {
    return this.cliRegistry.catalog();
  }

  async cliInstructions(id: string, revision: number) {
    return this.cliRegistry.instructions(id, revision);
  }

  async registerCli(id: string, revision: number, fingerprint: string, signal: AbortSignal) {
    return this.cliRegistry.register(id, revision, fingerprint, signal);
  }

  async list(owner: string) {
    const groups = await Promise.all(
      [this.storageRoot, this.configurationRoot].map(async (directory) => {
        const items = await readdir(this.ownerRoot(owner, directory), { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        return Promise.all(
          items
            .filter((item) => item.isDirectory())
            .map(async (item) => {
              const { root, value } = await this.newestIn(owner, item.name, directory);
              return value?.enabled ? this.view(owner, root, value) : null;
            }),
        );
      }),
    );
    const executors = groups.flat();
    const signal = AbortSignal.timeout(5000);
    const presets = await Promise.all(
      this.presets.map(async (preset) => {
        try {
          if (!(await this.cliRegistry.available(preset.id))) return null;
          await this.cliVerifiers.get(preset.id)?.(signal);
          return presetRecord(preset);
        } catch {
          return null;
        }
      }),
    );
    return {
      presets: presets.filter((preset) => preset !== null),
      executors: executors.flatMap((value) => (value ? [value] : [])),
      credentials: this.sharedCredentials.list(owner),
    };
  }

  async saveCredential(owner: string, input: unknown) {
    const row = creationRecord(input, ["id", "target", "name", "apiKey", "baseUrl", "revision"]);
    const id = creationUuid(row.id);
    const target = creationText(row.target, 64);
    const name = creationText(row.name, 80).trim();
    const revision = creationInteger(row.revision);
    if (!name) throw new MediaExecutorError("invalidInput");
    const presets = this.presets.filter((preset) => executorCredentialTarget(preset) === target);
    if (
      !presets.length ||
      !(await Promise.all(presets.map((preset) => this.cliRegistry.available(preset.id)))).some(Boolean)
    )
      throw new MediaExecutorError("notFound");
    const baseUrl =
      row.baseUrl === undefined || row.baseUrl === "" ? undefined : normalizeBaseUrl(creationText(row.baseUrl, 2048));
    if (baseUrl && !presets.some((preset) => !preset.fixedEndpoint && this.endpoints.get(preset.id)?.has(baseUrl)))
      throw new MediaExecutorError("invalidInput");
    const apiKey = row.apiKey === undefined ? undefined : executorApiKey(creationText(row.apiKey, 4096));
    return this.sharedCredentials.save(owner, { id, target, name, revision, baseUrl, apiKey });
  }

  async removeCredential(owner: string, id: string, revision: number) {
    this.sharedCredentials.remove(owner, id, revision);
  }

  async save(owner: string, input: unknown) {
    const row = creationRecord(input, [
      "id",
      "preset",
      "model",
      "name",
      "baseUrl",
      "apiKey",
      "credentialId",
      "revision",
    ]);
    const id = creationUuid(row.id),
      revision = creationInteger(row.revision);
    const preset = this.preset(creationText(row.preset, 64));
    if (!(await this.cliRegistry.available(preset.id))) throw new MediaExecutorError("notFound");
    const preferred = preset.kind === "image" || preset.kind === "video" ? this.storageRoot : this.configurationRoot;
    const { root, value } = await this.newest(owner, id, preferred);
    if (value && (!value.enabled || value.preset !== preset.id || value.revision > revision + 1))
      throw new MediaExecutorError("conflict");
    const previous = value ? await this.credentials(owner, value) : undefined;
    const previousCredentialId = typeof previous?.credentialId === "string" ? previous.credentialId : undefined;
    if (row.apiKey !== undefined && (row.credentialId !== undefined || previousCredentialId))
      throw new MediaExecutorError("invalidInput");
    const credentialId = row.credentialId === undefined ? previousCredentialId : creationUuid(row.credentialId);
    if (credentialId && row.baseUrl !== undefined) throw new MediaExecutorError("invalidInput");
    const target = executorCredentialTarget(preset);
    const shared = credentialId ? await this.sharedCredentials.resolve(owner, credentialId, target) : undefined;
    const baseUrl = this.endpoint(preset, credentialId ? shared?.baseUrl : row.baseUrl || value?.baseUrl);
    const secret = shared?.apiKey ?? row.apiKey ?? previous?.apiKey;
    const apiKey = executorApiKey(creationText(secret, 4096));
    const previousModel = typeof previous?.model === "string" ? previous.model : undefined;
    const model = row.model === undefined ? previousModel : creationText(row.model, 128);
    const option = preset.models.find((entry) => entry.id === model);
    if (model !== undefined && !option) throw new MediaExecutorError("invalidInput");
    const name = creationText(row.name || option?.name || preset.name, 80).trim();
    if (!name) throw new MediaExecutorError("invalidInput");
    const binding = { ownerId: owner, connectionId: id, connectorId: preset.id };
    if (
      value?.revision === revision + 1 &&
      value.name === name &&
      previousModel === model &&
      previousCredentialId === credentialId &&
      (credentialId || (previous?.apiKey === apiKey && previous?.baseUrl === baseUrl))
    )
      return this.view(owner, root, value);
    if ((value?.revision ?? 0) !== revision) throw new MediaExecutorError("conflict");
    const status = await this.providers.get(preset.id)!.check({ baseUrl, apiKey }, AbortSignal.timeout(15000), model);
    const envelope = await this.cipher.seal(binding, {
      ...(credentialId ? { credentialId, keyRevision: shared!.keyRevision } : { apiKey, baseUrl }),
      ...(model ? { model } : {}),
    });
    if (
      credentialId &&
      this.sharedCredentials.metadata(owner, credentialId, target).keyRevision !== shared!.keyRevision
    )
      throw new MediaExecutorError("conflict");
    const saved = {
      id,
      name,
      preset: preset.id,
      presetVersion: preset.version,
      kind: preset.kind,
      revision: revision + 1,
      enabled: true,
      status,
      baseUrl,
      envelope,
    };
    if (!value) await this.reserveStore(owner, id, preferred);
    if (!(await this.records(root).insert(saved))) throw new MediaExecutorError("conflict");
    return executorRecord(saved, model, credentialId);
  }

  async remove(owner: string, id: string, revision: number) {
    const { root, value } = await this.newest(owner, id);
    if (!value?.enabled) throw new MediaExecutorError("notFound");
    if (value.revision !== revision) throw new MediaExecutorError("conflict");
    if (!(await this.records(root).insert({ ...value, revision: revision + 1, enabled: false })))
      throw new MediaExecutorError("conflict");
  }

  async bind(owner: string, selection: ExternalChoice): Promise<ExternalBinding> {
    const { value } = await this.newest(owner, selection.executorId);
    if (!value?.enabled || value.kind !== selection.kind) throw new MediaExecutorError("notFound");
    const preset = this.preset(value.preset, value.presetVersion);
    if (!(await this.cliRegistry.available(preset.id))) throw new MediaExecutorError("notFound");
    const credential = await this.credentials(owner, value);
    const configuredModel = typeof credential.model === "string" ? credential.model : undefined;
    const model = selection.model ?? configuredModel ?? preset.models[0]!.id;
    if ((configuredModel && configuredModel !== model) || !preset.models.some((item) => item.id === model))
      throw new MediaExecutorError("invalidInput");
    let credentialRevision: number | undefined;
    if (typeof credential.credentialId === "string") {
      const saved = this.sharedCredentials.metadata(owner, credential.credentialId, executorCredentialTarget(preset));
      this.endpoint(preset, saved.baseUrl);
      credentialRevision = saved.keyRevision;
    } else this.endpoint(preset, value.baseUrl);
    return {
      ...selection,
      model,
      preset: value.preset,
      presetVersion: value.presetVersion,
      revision: value.revision,
      ...(credentialRevision ? { credentialRevision } : {}),
    };
  }

  async assertBound(owner: string, binding: ExternalBinding) {
    const current = await this.bind(owner, binding);
    if (
      current.revision !== binding.revision ||
      current.preset !== binding.preset ||
      current.presetVersion !== binding.presetVersion ||
      current.credentialRevision !== binding.credentialRevision ||
      current.model !== binding.model
    )
      throw new MediaExecutorError("conflict");
  }

  async submit(owner: string, binding: ExternalBinding, id: string, prompt: string, signal: AbortSignal) {
    const { connection, provider, root, value } = await this.open(owner, binding);
    const request: MediaRequest = { id, prompt, kind: binding.kind, model: binding.model };
    const result = await provider.submit(connection, request, signal);
    await this.confirm(root, value, result, binding.credentialRevision);
    return result;
  }

  async poll(owner: string, binding: ExternalBinding, taskId: string, signal: AbortSignal) {
    const { connection, provider, root, value } = await this.open(owner, binding).catch((error: unknown) => {
      if (
        error instanceof MediaExecutorError &&
        (error.code === "notFound" || error.code === "conflict" || error.code === "invalidInput")
      )
        throw new MediaExecutorError("stoppedLocally");
      throw error;
    });
    if (!provider.poll) throw new MediaExecutorError("invalidResult");
    const result = await provider.poll(connection, taskId, signal);
    await this.confirm(root, value, result, binding.credentialRevision);
    return result;
  }

  async cancel(owner: string, binding: ExternalBinding, taskId: string, signal: AbortSignal) {
    const { connection, provider } = await this.open(owner, binding);
    return provider.cancel ? provider.cancel(connection, taskId, signal) : { state: "stoppedLocally" as const };
  }

  private async open(owner: string, binding: ExternalBinding) {
    await this.assertBound(owner, binding);
    const { root, value } = await this.newest(owner, binding.executorId);
    if (!value?.enabled || value.revision !== binding.revision) throw new MediaExecutorError("conflict");
    const preset = this.preset(value.preset, value.presetVersion);
    const credential = await this.credentials(owner, value);
    const shared =
      typeof credential.credentialId === "string"
        ? await this.sharedCredentials.resolve(owner, credential.credentialId, executorCredentialTarget(preset))
        : undefined;
    const baseUrl = this.endpoint(preset, shared ? shared.baseUrl : value.baseUrl);
    const apiKey = shared?.apiKey ?? credential.apiKey;
    if (shared?.keyRevision !== binding.credentialRevision) throw new MediaExecutorError("conflict");
    if (typeof apiKey !== "string" || (!shared && credential.baseUrl !== baseUrl))
      throw new MediaExecutorError("authentication");
    await this.assertBound(owner, binding);
    return { connection: { apiKey, baseUrl }, provider: this.providers.get(preset.id)!, root, value };
  }
}
