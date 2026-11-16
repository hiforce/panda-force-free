import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { DocumentError } from "../../documents/errors.js";
import { CREATIVE_ASSET_LIMITS as limits, type CreativeAssetKind } from "../../../shared/creative/assets.js";
import type { CreativeText } from "./text.js";
import { CreativeTextCache } from "./text-cache.js";
import type { CreativePreviewResource } from "./preview-resources.js";
import { creativeResourceName } from "./codec.js";

function projection(value: unknown): CreativeText {
  const result = value as CreativeText | undefined;
  if (
    !result ||
    typeof result.text !== "string" ||
    Buffer.byteLength(result.text) > limits.textBytes ||
    !Array.isArray(result.sections) ||
    result.sections.length > 500 ||
    (result.previewHtml !== undefined &&
      (typeof result.previewHtml !== "string" || Buffer.byteLength(result.previewHtml) > limits.previewBytes))
  )
    throw new DocumentError("unavailable", 503);
  let end = 0;
  const ids = new Set<string>();
  for (const section of result.sections) {
    if (
      !section ||
      typeof section.id !== "string" ||
      ids.has(section.id) ||
      !Number.isSafeInteger(section.start) ||
      !Number.isSafeInteger(section.end) ||
      section.start < end ||
      section.end < section.start ||
      section.end > result.text.length
    )
      throw new DocumentError("unavailable", 503);
    ids.add(section.id);
    end = section.end;
  }
  return result;
}

/** Slots remain occupied until actual worker exit, including cancellation and timeout. No caller-controlled entry or path. */
export class CreativeTextWorkers {
  private readonly active = new Map<Worker, Promise<void>>();
  private readonly cache = new CreativeTextCache();
  private stopped = false;
  constructor(
    private readonly maximum = 2,
    private readonly timeoutMs = 15000,
  ) {}
  get running() {
    return this.active.size;
  }
  async extract(
    kind: CreativeAssetKind,
    name: string,
    input: Uint8Array,
    signal?: AbortSignal,
    preview = false,
    resources: readonly CreativePreviewResource[] = [],
  ): Promise<CreativeText> {
    if (this.stopped || signal?.aborted) throw new DocumentError("unavailable", 503);
    if (!input.length || input.length > (kind === "web" ? limits.htmlBytes : limits.sourceBytes))
      throw new DocumentError("tooLarge", 413);
    if (!Array.isArray(resources) || resources.length > limits.resources) throw new DocumentError("invalidInput");
    const captured = preview
      ? resources.map((file) => {
          if (!(file.bytes instanceof Uint8Array) || file.bytes.length > limits.resourceBytes)
            throw new DocumentError("tooLarge", 413);
          return { name: creativeResourceName(file.name), bytes: new Uint8Array(file.bytes) };
        })
      : [];
    if (captured.reduce((total, file) => total + file.bytes.length, input.length) > limits.totalBytes)
      throw new DocumentError("tooLarge", 413);
    const key = this.cache.key(kind, name, input, preview, captured),
      cached = this.cache.get(key);
    if (cached) return cached;
    if (this.active.size >= this.maximum) throw new DocumentError("busy", 429);
    const local = new URL("./text-worker.ts", import.meta.url),
      entry = existsSync(local) ? local : new URL("../src/server/creative/assets/text-worker.ts", import.meta.url),
      bytes = new Uint8Array(input),
      worker = new Worker(entry, {
        workerData: { kind, name, bytes, preview, resources: captured },
        transferList: [bytes.buffer, ...captured.map((file) => file.bytes.buffer)],
      });
    let exited!: () => void,
      cancel = () => {};
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    this.active.set(worker, exit);
    const result = new Promise<CreativeText>((resolve, reject) => {
      let value: CreativeText | undefined,
        failure: unknown,
        cancelled = false;
      cancel = () => {
        if (cancelled) return;
        cancelled = true;
        reject(new DocumentError("unavailable", 503));
        void worker.terminate().catch(() => {});
      };
      worker.once("message", (message) => {
        try {
          if (message?.ok === true) value = projection(message.value);
          else
            failure = new DocumentError(
              message?.code === "tooLarge" ? "tooLarge" : "invalidInput",
              message?.code === "tooLarge" ? 413 : 400,
            );
        } catch (error) {
          failure = error;
        }
      });
      worker.once("error", (error) => {
        failure = error;
      });
      worker.once("exit", (code) => {
        this.active.delete(worker);
        exited();
        if (!cancelled) {
          if (failure instanceof DocumentError) reject(failure);
          else if (code !== 0 || failure || !value) reject(new DocumentError("unavailable", 503));
          else resolve(value);
        }
      });
    });
    const timer = setTimeout(cancel, this.timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      const value = await result;
      if (this.stopped || signal?.aborted) throw new DocumentError("unavailable", 503);
      this.cache.put(key, value);
      return value;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  async close() {
    this.stopped = true;
    this.cache.clear();
    const exits = [...this.active.values()];
    for (const worker of this.active.keys()) void worker.terminate().catch(() => {});
    await Promise.all(exits);
  }
}
const workers = new CreativeTextWorkers();
export const extractCreativeText = workers.extract.bind(workers);
export const closeCreativeText = () => workers.close();
