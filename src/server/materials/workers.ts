import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import {
  MATERIAL_TEXT_LIMITS as limits,
  MATERIAL_TEXT_VERSION,
  MaterialTextError,
  type MaterialText,
  type MaterialTextFailure,
} from "./contracts.js";
const failures: readonly MaterialTextFailure[] = [
  "unsupported",
  "unreadable",
  "empty",
  "encrypted",
  "tooLarge",
  "busy",
];
function projection(value: unknown): MaterialText {
  const row = value as Partial<MaterialText>;
  if (
    !row ||
    typeof row.text !== "string" ||
    !row.text.trim() ||
    row.text.includes("\0") ||
    Buffer.byteLength(row.text) > limits.textBytes ||
    !Number.isSafeInteger(row.sections) ||
    row.sections! < 1 ||
    row.sections! > limits.parts
  )
    throw new MaterialTextError("unreadable");
  return { text: row.text, sections: row.sections! };
}
/** Source parsing is shared; authority and original-byte verification remain with each caller. */
export class MaterialTextWorkers {
  private readonly cache = new Map<string, { value: MaterialText; bytes: number }>();
  private cacheBytes = 0;
  private readonly pending = new Map<string, Promise<MaterialText>>();
  private readonly active = new Map<Worker, Promise<void>>();
  private closed = false;
  constructor(
    private readonly maximum = 2,
    private readonly timeoutMs = 15000,
  ) {}
  async read(name: string, input: Uint8Array): Promise<MaterialText> {
    if (this.closed) throw new MaterialTextError("busy");
    if (!(input instanceof Uint8Array) || input.length > limits.inputBytes) throw new MaterialTextError("tooLarge");
    const format = extname(name).toLowerCase();
    if (![".pdf", ".docx", ".xlsx", ".pptx"].includes(format)) throw new MaterialTextError("unsupported");
    const key = createHash("sha256")
        .update(MATERIAL_TEXT_VERSION + ":" + format + ":")
        .update(input)
        .digest("hex"),
      cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { ...cached.value };
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.active.size >= this.maximum) throw new MaterialTextError("busy");
    const work = this.run(name, input)
      .then((value) => {
        if (this.closed) return value;
        const bytes = Buffer.byteLength(value.text);
        this.cache.set(key, { value, bytes });
        this.cacheBytes += bytes;
        while (this.cacheBytes > 16 * 1024 * 1024 || this.cache.size > 32) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.bytes;
          this.cache.delete(oldest);
        }
        return { ...value };
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  private run(name: string, input: Uint8Array): Promise<MaterialText> {
    const local = new URL("./worker.ts", import.meta.url),
      entry = existsSync(local) ? local : new URL("../src/server/materials/worker.ts", import.meta.url),
      bytes = new Uint8Array(input),
      worker = new Worker(entry, { workerData: { name, bytes }, transferList: [bytes.buffer] });
    let exited!: () => void;
    const done = new Promise<void>((resolve) => {
      exited = resolve;
    });
    this.active.set(worker, done);
    return new Promise((resolve, reject) => {
      let value: MaterialText | undefined, failure: MaterialTextError | undefined;
      const timer = setTimeout(() => {
        failure = new MaterialTextError("tooLarge");
        void worker.terminate().catch(() => {});
      }, this.timeoutMs);
      timer.unref();
      worker.unref();
      worker.once("message", (message) => {
        try {
          if (message?.ok === true) value = projection(message.value);
          else failure = new MaterialTextError(failures.includes(message?.code) ? message.code : "unreadable");
        } catch {
          failure = new MaterialTextError("unreadable");
        }
      });
      worker.once("error", () => {
        failure = new MaterialTextError("unreadable");
        void worker.terminate().catch(() => {});
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        this.active.delete(worker);
        exited();
        if (failure) reject(failure);
        else if (code !== 0 || !value) reject(new MaterialTextError("unreadable"));
        else resolve(value);
      });
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active.keys()].map((worker) => worker.terminate()));
    await Promise.all([...this.active.values()]);
    this.cache.clear();
    this.cacheBytes = 0;
  }
}
