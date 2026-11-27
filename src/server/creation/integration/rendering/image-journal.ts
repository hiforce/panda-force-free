import { join } from "node:path";
import type { CreationEngineProfile } from "../../../../shared/creation/contracts.js";
import { stableJson } from "../../../../shared/stable-json.js";
import { FilePackageContent } from "../../../packages/content-store.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../../validation.js";
import { creationEngineProfile, creationPrompt } from "../../input-values.js";
import {
  ImageRenderError,
  type ImageRenderRequest,
  type ImageRenderIntent,
  type ImageRenderReceipt,
} from "./image-contracts.js";
import { decodedImage, imageDigest } from "./image-result.js";

type Stage = "intent" | "binding" | "dispatch" | "result";
interface Entry {
  key: string;
  signature: string;
  stage: Stage;
  data: unknown;
}
function entry(value: unknown): Entry {
  const row = creationRecord(value, ["key", "signature", "stage", "data"]);
  if (!["intent", "binding", "dispatch", "result"].includes(String(row.stage)))
    throw new ImageRenderError("invalidInput");
  return {
    key: creationDigest(row.key),
    signature: creationDigest(row.signature),
    stage: row.stage as Stage,
    data: row.data,
  };
}
function imageProfile(profile: CreationEngineProfile) {
  return profile.engineId === "codex"
    ? !profile.runtimeId || profile.runtimeId === "codex"
    : !!profile.runtimeId && profile.engineId === `harness-${profile.runtimeId}`;
}
export async function imageRenderIntent(input: ImageRenderRequest): Promise<ImageRenderIntent> {
  const owner = creationText(input.owner, 200),
    taskId = creationUuid(input.taskId),
    contextDigest = creationDigest(input.contextDigest),
    slot = creationInteger(input.slot),
    prompt = creationPrompt(input.prompt),
    profile = creationEngineProfile(input.profile);
  if (!slot || slot > 8 || !imageProfile(profile) || (input.images?.length ?? 0) > 2)
    throw new ImageRenderError("invalidInput");
  const inputs: ImageRenderIntent["inputs"] = [];
  for (const bytes of input.images ?? []) {
    if (bytes.byteLength > 8 * 1024 * 1024) throw new ImageRenderError("invalidInput");
    inputs.push({ digest: imageDigest(bytes), mime: (await decodedImage(bytes)).mime });
  }
  const identity = { owner, taskId, contextDigest, slot },
    content = { ...identity, prompt, profile, inputs };
  return {
    schema: 1,
    key: imageDigest(stableJson({ purpose: "creation-image-render", ...identity })),
    signature: imageDigest(stableJson(content)),
    ...content,
  };
}
function result(value: unknown): ImageRenderReceipt {
  const row = creationRecord(value, [
      "digest",
      "size",
      "width",
      "height",
      "mime",
      "threadId",
      "turnId",
      "provider",
      "invocationId",
    ]),
    size = creationInteger(row.size),
    width = creationInteger(row.width),
    height = creationInteger(row.height);
  if (
    !size ||
    size > 32 * 1024 * 1024 ||
    !width ||
    !height ||
    width * height > 40_000_000 ||
    !["image/png", "image/jpeg", "image/webp"].includes(String(row.mime))
  )
    throw new ImageRenderError("invalidResult");
  const asset = {
    digest: creationDigest(row.digest),
    size,
    width,
    height,
    mime: row.mime as ImageRenderReceipt["mime"],
  };
  if (
    (row.provider === "zcode" || row.provider === "grok-build") &&
    row.threadId === undefined &&
    row.turnId === undefined
  ) {
    if (
      row.invocationId !== undefined &&
      (typeof row.invocationId !== "string" || !/^[a-z\d_-]{1,160}$/i.test(row.invocationId))
    )
      throw new ImageRenderError("invalidResult");
    return {
      ...asset,
      provider: row.provider,
      ...(row.invocationId === undefined ? {} : { invocationId: row.invocationId }),
    };
  }
  if (row.provider !== undefined || row.invocationId !== undefined) throw new ImageRenderError("invalidResult");
  return { ...asset, threadId: creationUuid(row.threadId), turnId: creationUuid(row.turnId) };
}
/** Immutable dispatch claims prevent retries or competing processes from sending a second inference. */
export class ImageRenderJournal {
  private readonly entries: FilePackageContent<Entry>;
  private readonly originals: FilePackageContent<Uint8Array>;
  constructor(root: string) {
    this.entries = new FilePackageContent(join(root, "records"), {
      maxBytes: 262144,
      encode: async (value) => Buffer.from(stableJson(entry(value))),
      decode: async (bytes) => entry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: (value) => imageDigest(stableJson({ key: value.key, stage: value.stage })),
    });
    this.originals = new FilePackageContent<Uint8Array>(join(root, "originals"), {
      extension: ".source",
      maxBytes: 32 * 1024 * 1024,
      encode: async (bytes) => bytes,
      decode: async (bytes) => bytes,
      digest: imageDigest,
    });
  }
  async resolve(owner: string, taskId: string, handle: string) {
    const key = creationDigest(handle);
    const stored = await this.entries.read(imageDigest(stableJson({ key, stage: "intent" }))).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ImageRenderError("invalidInput");
        throw error;
      }),
      row = creationRecord(stored.data, [
        "schema",
        "key",
        "signature",
        "owner",
        "taskId",
        "contextDigest",
        "slot",
        "prompt",
        "profile",
        "inputs",
      ]);
    if (
      row.owner !== owner ||
      row.taskId !== taskId ||
      row.schema !== 1 ||
      !Array.isArray(row.inputs) ||
      row.inputs.length > 2
    )
      throw new ImageRenderError("invalidInput");
    const identity = {
        owner: creationText(row.owner, 200),
        taskId: creationUuid(row.taskId),
        contextDigest: creationDigest(row.contextDigest),
        slot: creationInteger(row.slot),
      },
      content = {
        ...identity,
        prompt: creationPrompt(row.prompt),
        profile: creationEngineProfile(row.profile),
        inputs: row.inputs.map((value) => {
          const input = creationRecord(value, ["digest", "mime"]);
          if (!["image/png", "image/jpeg", "image/webp"].includes(String(input.mime)))
            throw new ImageRenderError("invalidInput");
          return { digest: creationDigest(input.digest), mime: input.mime as string };
        }),
      },
      signature = imageDigest(stableJson(content));
    if (
      !identity.slot ||
      identity.slot > 8 ||
      !imageProfile(content.profile) ||
      imageDigest(stableJson({ purpose: "creation-image-render", ...identity })) !== key ||
      row.key !== key ||
      row.signature !== signature ||
      stored.key !== key ||
      stored.signature !== signature ||
      stored.stage !== "intent"
    )
      throw new ImageRenderError("conflict");
    const intent: ImageRenderIntent = { schema: 1, key, signature, ...content },
      receipt = await this.receipt(intent);
    if (!receipt) throw new ImageRenderError("uncertain");
    return { intent, receipt };
  }
  async read(intent: ImageRenderIntent, stage: Stage): Promise<unknown | null> {
    try {
      const found = await this.entries.read(imageDigest(stableJson({ key: intent.key, stage })));
      if (found.key !== intent.key || found.stage !== stage || found.signature !== intent.signature)
        throw new ImageRenderError("conflict");
      return found.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async insert(intent: ImageRenderIntent, stage: Stage, data: unknown) {
    const inserted = await this.entries.insert({ key: intent.key, signature: intent.signature, stage, data });
    await this.read(intent, stage);
    return inserted;
  }
  async receipt(intent: ImageRenderIntent) {
    const saved = await this.read(intent, "result");
    if (!saved) return null;
    const value = result(saved),
      bytes = Buffer.from(await this.originals.read(value.digest));
    if (bytes.length !== value.size) throw new ImageRenderError("invalidResult");
    const info = await decodedImage(bytes);
    if (info.mime !== value.mime || info.width !== value.width || info.height !== value.height)
      throw new ImageRenderError("invalidResult");
    return { ...value, bytes };
  }
  async save(intent: ImageRenderIntent, bytes: Uint8Array, receipt: ImageRenderReceipt) {
    const value = result(receipt);
    if (bytes.byteLength !== value.size || imageDigest(bytes) !== value.digest)
      throw new ImageRenderError("invalidResult");
    await this.originals.put(bytes);
    await this.insert(intent, "result", value);
    const saved = await this.receipt(intent);
    if (!saved) throw new ImageRenderError("conflict");
    const { bytes: _bytes, ...fields } = saved;
    if (stableJson(fields) !== stableJson(value)) throw new ImageRenderError("conflict");
    return saved;
  }
}
