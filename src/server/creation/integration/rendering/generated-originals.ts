import { join } from "node:path";
import { stableJson } from "../../../../shared/stable-json.js";
import { FilePackageContent } from "../../../packages/content-store.js";
import { creativeResourceName } from "../../../creative/assets/codec.js";
import { CreationError } from "../../contracts.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../../validation.js";
import { imageDigest } from "./image-result.js";

export type GeneratedKind = "slides" | "web" | "video";
export class CreationCandidateChanged extends Error {}
export interface GeneratedOriginal {
  kind: GeneratedKind;
  name: string;
  bytes: Uint8Array;
  resources?: readonly { name: string; bytes: Uint8Array }[];
}
interface Intent {
  owner: string;
  taskId: string;
  contextDigest: string;
  kind: GeneratedKind;
  slot: number;
  signature: string;
}
interface Receipt extends Intent {
  source: { name: string; digest: string; size: number };
  resources: Receipt["source"][];
}
function intent(value: unknown): Intent {
  const r = creationRecord(value, ["owner", "taskId", "contextDigest", "kind", "slot", "signature"]),
    slot = creationInteger(r.slot);
  if (!["slides", "web", "video"].includes(String(r.kind)) || !slot || slot > 8)
    throw new CreationError("invalidInput");
  return {
    owner: creationText(r.owner, 200),
    taskId: creationUuid(r.taskId),
    contextDigest: creationDigest(r.contextDigest),
    kind: r.kind as GeneratedKind,
    slot,
    signature: creationDigest(r.signature),
  };
}
const handle = ({ owner, taskId, contextDigest, kind, slot }: Intent) =>
  imageDigest(stableJson({ purpose: "creation-generated-original", owner, taskId, contextDigest, kind, slot }));
function descriptor(value: unknown): Receipt["source"] {
  const r = creationRecord(value, ["name", "digest", "size"]),
    size = creationInteger(r.size);
  if (size > 32 * 1024 * 1024) throw new CreationError("invalidOutput");
  return { name: creativeResourceName(r.name), digest: creationDigest(r.digest), size };
}
function receipt(value: unknown): Receipt {
  const row = creationRecord(value, ["intent", "source", "resources"]),
    source = descriptor(row.source);
  if (!source.size || !Array.isArray(row.resources) || row.resources.length > 128)
    throw new CreationError("invalidOutput");
  const resources = row.resources.map(descriptor);
  if (
    resources.some((r) => r.size > 8 * 1024 * 1024) ||
    resources.reduce((n, r) => n + r.size, source.size) > 64 * 1024 * 1024 ||
    new Set([source.name, ...resources.map((r) => r.name)].map((s) => s.toLowerCase())).size !== resources.length + 1
  )
    throw new CreationError("invalidOutput");
  return { ...intent(row.intent), source, resources };
}
/** Immutable originals and task-scoped receipts survive renderer restarts without trusting a model-selected path or project. */
export class CreationGeneratedOriginals {
  private readonly records: FilePackageContent<Receipt>;
  private readonly intents: FilePackageContent<Intent>;
  private readonly bytes: FilePackageContent<Uint8Array>;
  private readonly pending = new Map<string, { signature: string; work: Promise<string> }>();
  constructor(root: string) {
    this.intents = new FilePackageContent<Intent>(join(root, "intents"), {
      maxBytes: 2048,
      encode: async (v) => Buffer.from(stableJson(intent(v))),
      decode: async (b) => intent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b))),
      digest: handle,
    });
    this.records = new FilePackageContent<Receipt>(join(root, "receipts"), {
      maxBytes: 65536,
      encode: async (v) => {
        const { source, resources, ...identity } = v;
        return Buffer.from(stableJson({ intent: identity, source, resources }));
      },
      decode: async (b) => receipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b))),
      digest: handle,
    });
    this.bytes = new FilePackageContent<Uint8Array>(join(root, "originals"), {
      maxBytes: 32 * 1024 * 1024,
      extension: ".source",
      encode: async (v: Uint8Array) => v,
      decode: async (v) => v,
      digest: imageDigest,
    });
  }
  async render(raw: Intent, generate: () => Promise<GeneratedOriginal>, authorize: () => Promise<void>) {
    const input = intent(structuredClone(raw)),
      key = handle(input),
      prior = this.pending.get(key);
    if (prior && prior.signature !== input.signature) throw new CreationCandidateChanged();
    if (prior) return prior.work;
    const work = this.write(input, generate, authorize).finally(() => this.pending.delete(key));
    this.pending.set(key, { signature: input.signature, work });
    return work;
  }
  private async write(input: Intent, generate: () => Promise<GeneratedOriginal>, authorize: () => Promise<void>) {
    const key = handle(input);
    await authorize();
    await this.intents.put(input);
    if (stableJson(await this.intents.read(key)) !== stableJson(input)) throw new CreationCandidateChanged();
    try {
      await this.resolve(input.owner, input.taskId, input.kind, key);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const original = await generate();
    await authorize();
    if (original.kind !== input.kind) throw new CreationError("invalidOutput");
    const source = { name: original.name, digest: imageDigest(original.bytes), size: original.bytes.byteLength },
      resources = (original.resources ?? []).map((r) => ({
        name: r.name,
        digest: imageDigest(r.bytes),
        size: r.bytes.byteLength,
      })),
      record = receipt({ intent: input, source, resources });
    await this.bytes.put(original.bytes);
    for (const resource of original.resources ?? []) await this.bytes.put(resource.bytes);
    await authorize();
    await this.records.put(record);
    const saved = await this.resolve(input.owner, input.taskId, input.kind, key);
    if (saved.signature !== input.signature) throw new CreationCandidateChanged();
    return key;
  }
  async resolve(owner: string, taskId: string, kind: GeneratedKind, key: string) {
    const record = await this.records.read(creationDigest(key)),
      expected = await this.intents.read(key);
    if (
      record.owner !== owner ||
      record.taskId !== taskId ||
      record.kind !== kind ||
      handle(record) !== key ||
      stableJson(expected) !==
        stableJson(
          intent({
            owner: record.owner,
            taskId: record.taskId,
            contextDigest: record.contextDigest,
            kind: record.kind,
            slot: record.slot,
            signature: record.signature,
          }),
        )
    )
      throw new CreationError("notFound");
    const bytes = Buffer.from(await this.bytes.read(record.source.digest));
    if (bytes.length !== record.source.size) throw new CreationError("invalidOutput");
    const resources: { name: string; bytes: Buffer }[] = [];
    for (const item of record.resources) {
      const bytes = Buffer.from(await this.bytes.read(item.digest));
      if (bytes.length !== item.size) throw new CreationError("invalidOutput");
      resources.push({ name: item.name, bytes });
    }
    return { ...record, bytes, resources };
  }
}
