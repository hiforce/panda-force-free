import { randomUUID } from "node:crypto";
import type { CreativeAssetKind, CreativeResource } from "../../shared/creative/assets.js";
import { stableJson } from "../../shared/stable-json.js";
import { ObjectStorageError, type S3ObjectReceipt } from "./contracts.js";
import type { OriginalStorageConfiguration } from "./configuration.js";
import { storageSha256 } from "./sigv4.js";
import { storageDigest, storageOperationId, storageRecord } from "./config-codec.js";
import {
  originalDescriptor,
  originalIntegrity,
  originalObjectReceipt,
  originalScope,
  originalUploadIntent,
  storedOriginalScope,
  type OriginalScope,
  type OriginalUploadIntent,
  type StoredOriginalScope,
} from "./original-codec.js";

interface UploadResource {
  descriptor: { digest: string; size: number };
  intent: OriginalUploadIntent;
}
export interface OriginalUploadPlan {
  scope: StoredOriginalScope | null;
  remote: boolean;
  history: boolean;
  resources: UploadResource[];
}
const base = (scope: string) => ["objects", scope.slice(0, 2), scope];
const digestBase = (scope: string, digest: string) => [...base(scope), "data", digest];
const intentPath = (intent: OriginalUploadIntent, suffix = "json") => [
  ...digestBase(intent.scope, intent.digest),
  intent.id + "." + suffix,
];
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** Reserve under the project's lease, then transfer outside it. Every external write has a durable, single-dispatch identity. */
export class OriginalObjectStorage {
  readonly files;
  constructor(
    readonly configuration: OriginalStorageConfiguration,
    private readonly authenticated: () => boolean,
  ) {
    this.files = configuration.files;
  }
  assertAuthenticated() {
    if (!this.authenticated()) throw new ObjectStorageError("storageAuthenticationRequired");
  }
  private async identity(input: OriginalScope, create: boolean): Promise<StoredOriginalScope | null> {
    const scope = originalScope(input);
    if (!create && !(await this.files.present())) return null;
    const key = await this.files.scope("original:" + stableJson(scope)),
      path = [...base(key), "identity.json"],
      identity: StoredOriginalScope = { schema: 1, scope: key, ...scope };
    if (create) await this.files.writeOnce(path, identity);
    const stored = await this.files.read(path);
    if (stored === null) return null;
    if (!same(storedOriginalScope(stored), identity)) return originalIntegrity();
    return identity;
  }
  private async writeSame(path: string[], value: unknown) {
    if (!(await this.files.writeOnce(path, value)) && !same(await this.files.read(path), value)) originalIntegrity();
  }
  private async intent(value: unknown, scope: StoredOriginalScope, digest?: string) {
    const intent = originalUploadIntent(value),
      { signature, ...content } = intent;
    if (
      intent.scope !== scope.scope ||
      (digest !== undefined && intent.digest !== digest) ||
      (await this.files.scope(stableJson(content))) !== signature
    )
      originalIntegrity();
    return intent;
  }
  private markerContent(intent: OriginalUploadIntent, suffix: string) {
    return this.files.scope(stableJson({ intent, marker: suffix }));
  }
  private async marker(intent: OriginalUploadIntent, suffix: string) {
    const value = await this.files.read(intentPath(intent, suffix));
    if (value === null) return false;
    if (!same(value, { id: intent.id, signature: await this.markerContent(intent, suffix) })) originalIntegrity();
    return true;
  }
  private async claim(intent: OriginalUploadIntent, suffix: string) {
    const written = await this.files.writeOnce(intentPath(intent, suffix), {
      id: intent.id,
      signature: await this.markerContent(intent, suffix),
    });
    if (!(await this.marker(intent, suffix))) originalIntegrity();
    return written;
  }
  private async verifyReceipt(intent: OriginalUploadIntent, raw: unknown) {
    const record = storageRecord(raw, ["receipt", "signature"]),
      receipt = originalObjectReceipt(record.receipt);
    if (
      receipt.intentId !== intent.id ||
      receipt.digest !== intent.digest ||
      receipt.size !== intent.size ||
      (await this.files.scope(stableJson({ intent, receipt }))) !== record.signature
    )
      originalIntegrity();
    return receipt;
  }
  private async recordReceipt(intent: OriginalUploadIntent, receipt: S3ObjectReceipt) {
    await this.writeSame(intentPath(intent, "receipt.json"), {
      receipt,
      signature: await this.files.scope(stableJson({ intent, receipt })),
    });
  }
  private async chosen(scope: StoredOriginalScope, descriptor: { digest: string; size: number }) {
    const raw = await this.files.read([...digestBase(scope.scope, descriptor.digest), "chosen.json"]);
    if (raw === null) return null;
    const record = storageRecord(raw, ["intentId"]),
      id = storageOperationId(record.intentId),
      intent = await this.intent(
        await this.files.read([...digestBase(scope.scope, descriptor.digest), id + ".json"]),
        scope,
        descriptor.digest,
      );
    if (intent.id !== id || intent.size !== descriptor.size) originalIntegrity();
    const receipt = await this.verifyReceipt(intent, await this.files.read(intentPath(intent, "receipt.json")));
    return { intent, receipt };
  }
  async hasHistory(input: OriginalScope) {
    return (await this.identity(input, false)) !== null;
  }
  async reserve(
    input: OriginalScope,
    kind: CreativeAssetKind,
    resources: readonly CreativeResource[],
  ): Promise<OriginalUploadPlan> {
    const target = await this.configuration.writeTarget(kind);
    if (target) this.assertAuthenticated();
    const scope = await this.identity(input, !!target);
    if (scope && (await this.files.read([...base(scope.scope), "purge.json"])) !== null)
      throw new ObjectStorageError("storageConflict");
    const plan: OriginalUploadPlan = { scope, remote: !!target, history: !!scope, resources: [] };
    if (!target || !scope) return plan;
    for (const resource of resources) {
      const descriptor = originalDescriptor(resource),
        existing = await this.chosen(scope, descriptor);
      if (existing) {
        plan.resources.push({ descriptor, intent: existing.intent });
        continue;
      }
      let selected: OriginalUploadIntent | undefined;
      const folder = digestBase(scope.scope, descriptor.digest);
      for (const name of await this.files.list(folder)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const intent = await this.intent(await this.files.read([...folder, name]), scope, descriptor.digest);
        if (intent.id + ".json" !== name || intent.size !== descriptor.size) originalIntegrity();
        if (
          intent.profileId === target.profile.id &&
          intent.profileDigest === target.digest &&
          !(await this.marker(intent, "rejected.json")) &&
          !(await this.marker(intent, "not-sent.json"))
        )
          selected = intent;
      }
      if (!selected) {
        const id = randomUUID(),
          installation = await this.files.installation(),
          key = [target.profile.prefix, "panda-originals", installation, scope.scope, descriptor.digest, id]
            .filter(Boolean)
            .join("/"),
          content = {
            schema: 1 as const,
            scope: scope.scope,
            ...descriptor,
            id,
            profileId: target.profile.id,
            profileDigest: target.digest,
            key,
          };
        selected = { ...content, signature: await this.files.scope(stableJson(content)) };
        await this.writeSame(intentPath(selected), selected);
      }
      plan.resources.push({ descriptor, intent: selected });
    }
    return plan;
  }
  private async client(intent: OriginalUploadIntent) {
    return (await this.configuration.client(intent.profileId, intent.profileDigest)).client;
  }
  async upload(
    plan: OriginalUploadPlan,
    contents: readonly { digest: string; bytes: Uint8Array }[],
    signal?: AbortSignal,
  ) {
    if (!plan.remote || !plan.scope) return;
    this.assertAuthenticated();
    for (const row of plan.resources) {
      const intent = await this.intent(row.intent, plan.scope, row.descriptor.digest),
        bytes = contents.find((value) => value.digest === intent.digest)?.bytes;
      if (!bytes || bytes.byteLength !== intent.size || storageSha256(bytes) !== intent.digest) originalIntegrity();
      if (signal?.aborted) throw new ObjectStorageError("storageUnavailable", true);
      if ((await this.files.read([...base(intent.scope), "purge.json"])) !== null)
        throw new ObjectStorageError("storageConflict");
      const chosen = await this.chosen(plan.scope, row.descriptor);
      if (chosen) continue;
      const client = await this.client(intent),
        dispatch = "dispatch.json";
      // Check reachability and read authority before the first dispatch, so an offline or misconfigured provider remains retryable without an uncertain PUT.
      if (!(await this.marker(intent, dispatch)) && (await client.head(intent.key, undefined, signal)) !== null)
        throw new ObjectStorageError("storageConflict");
      if (await this.claim(intent, dispatch)) {
        if (signal?.aborted || (await this.files.read([...base(intent.scope), "purge.json"])) !== null) {
          await this.claim(intent, "not-sent.json");
          throw new ObjectStorageError("storageUnavailable", true);
        }
        try {
          const result = await client.put(intent.key, bytes, intent.id, signal);
          if (result.state === "exists") {
            await this.claim(intent, "rejected.json");
            throw new ObjectStorageError("storageConflict");
          }
          if (result.state === "written")
            await this.recordReceipt(intent, {
              ...row.descriptor,
              intentId: intent.id,
              versionId: result.versionId,
              etag: result.etag,
            });
        } catch (error) {
          // A received authorization or input rejection cannot create an object. Transport errors remain uncertain.
          if (
            error instanceof ObjectStorageError &&
            error.status !== undefined &&
            [400, 401, 403, 404, 413].includes(error.status)
          )
            await this.claim(intent, "rejected.json");
          throw error;
        }
      }
      let receipt: S3ObjectReceipt;
      const acknowledged = await this.files.read(intentPath(intent, "receipt.json"));
      if (acknowledged !== null) receipt = await this.verifyReceipt(intent, acknowledged);
      else {
        const observed = await client.head(intent.key, undefined, signal);
        if (!observed) throw new ObjectStorageError("storageUnavailable", true);
        receipt = observed;
        if (receipt.intentId !== intent.id || receipt.digest !== intent.digest || receipt.size !== intent.size)
          originalIntegrity();
        await this.recordReceipt(intent, receipt);
      }
      await client.get(intent.key, receipt, signal);
      if (signal?.aborted) throw new ObjectStorageError("storageUnavailable", true);
      this.assertAuthenticated();
      if ((await this.files.read([...base(intent.scope), "purge.json"])) !== null)
        throw new ObjectStorageError("storageConflict");
      await this.files.writeOnce([...digestBase(intent.scope, intent.digest), "chosen.json"], { intentId: intent.id });
      if (!(await this.chosen(plan.scope, row.descriptor))) originalIntegrity();
    }
  }
  async verifyReferences(input: OriginalScope, resources: readonly CreativeResource[]) {
    this.assertAuthenticated();
    const scope = await this.identity(input, false);
    if (!scope || (await this.files.read([...base(scope.scope), "purge.json"])) !== null) originalIntegrity();
    for (const resource of resources)
      if (!(await this.chosen(scope, originalDescriptor(resource)))) originalIntegrity();
  }
  async read(
    input: OriginalScope,
    resource: CreativeResource,
    signal?: AbortSignal,
    range?: { start: number; end: number },
  ) {
    this.assertAuthenticated();
    const scope = await this.identity(input, false);
    if (!scope || (await this.files.read([...base(scope.scope), "purge.json"])) !== null) originalIntegrity();
    const chosen = await this.chosen(scope, originalDescriptor(resource));
    if (!chosen) originalIntegrity();
    return (await this.client(chosen.intent)).get(chosen.intent.key, chosen.receipt, signal, range);
  }
  /** A caller must validate trash/version and commit this operation in the owning Git transaction before cleanup. */
  async beginPurge(input: OriginalScope, operationId: string) {
    const scope = await this.identity(input, false);
    if (!scope) return;
    const content = { schema: 1, scope: scope.scope, operationId: storageOperationId(operationId) };
    const record = { ...content, signature: await this.files.scope(stableJson(content)) };
    const path = [...base(scope.scope), "purge.json"];
    if (!(await this.files.writeOnce(path, record)) && !same(await this.files.read(path), record))
      throw new ObjectStorageError("storageConflict");
  }
  async purge(input: OriginalScope, operationId: string, committed: () => Promise<void>, signal?: AbortSignal) {
    const scope = await this.identity(input, false);
    if (!scope) return { complete: true };
    const raw = storageRecord(await this.files.read([...base(scope.scope), "purge.json"]), [
        "schema",
        "scope",
        "operationId",
        "signature",
      ]),
      content = { schema: 1, scope: scope.scope, operationId: storageOperationId(operationId) };
    if (!same(raw, { ...content, signature: await this.files.scope(stableJson(content)) })) originalIntegrity();
    await committed();
    let complete = true;
    for (const digest of await this.files.directories([...base(scope.scope), "data"])) {
      storageDigest(digest);
      for (const name of await this.files.list(digestBase(scope.scope, digest))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const intent = await this.intent(
          await this.files.read([...digestBase(scope.scope, digest), name]),
          scope,
          digest,
        );
        if (intent.id + ".json" !== name) originalIntegrity();
        if (await this.marker(intent, "cleaned.json")) continue;
        await committed();
        const acknowledged = await this.files.read(intentPath(intent, "receipt.json")),
          dispatched = await this.marker(intent, "dispatch.json"),
          rejected = await this.marker(intent, "rejected.json"),
          notSent = await this.marker(intent, "not-sent.json");
        if (!dispatched || rejected || notSent) {
          if (acknowledged !== null) originalIntegrity();
          await this.claim(intent, "cleaned.json");
          continue;
        }
        const client = await this.client(intent);
        let receipt: S3ObjectReceipt;
        if (acknowledged !== null) receipt = await this.verifyReceipt(intent, acknowledged);
        else {
          const observed = await client.head(intent.key, undefined, signal);
          // A missing object does not prove that a dispatched PUT cannot still arrive later.
          if (!observed) {
            complete = false;
            continue;
          }
          if (observed.intentId !== intent.id || observed.digest !== intent.digest || observed.size !== intent.size)
            originalIntegrity();
          receipt = observed;
          await this.recordReceipt(intent, receipt);
        }
        await client.delete(intent.key, receipt, signal);
        if ((await client.head(intent.key, receipt.versionId, signal)) !== null)
          throw new ObjectStorageError("storageUnavailable", true);
        await this.claim(intent, "cleaned.json");
      }
    }
    return { complete };
  }
}
