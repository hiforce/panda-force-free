import { BuildError, BUILD_LIMITS, buildInput } from "./validation.js";
import {
  decodeResourceBuild,
  RESOURCE_FRAME_HEADER,
  RESOURCE_FRAME_MAGIC,
  RESOURCE_FRAME_MAX,
  resourceFrameSize,
} from "./resource-frame.js";
import type { ExecutionInput } from "./resources.js";

/** Docker attach does not close stdin: native framing is exact-length, while legacy callers retain their JSON line. */
export class WorkerInputCollector {
  private chunks: Uint8Array[] = [];
  private prefix = new Uint8Array(RESOURCE_FRAME_HEADER);
  private size = 0;
  private expected: number | null = null;
  private native = false;
  private complete = false;
  push(value: Uint8Array): boolean {
    if (this.complete) throw new BuildError("invalidResourceBuild");
    const prior = this.size;
    this.size += value.length;
    if (prior < this.prefix.length) this.prefix.set(value.subarray(0, this.prefix.length - prior), prior);
    if (this.size && this.prefix[0] === RESOURCE_FRAME_MAGIC[0]) this.native = true;
    if (this.size > (this.native ? RESOURCE_FRAME_MAX : BUILD_LIMITS.inputBytes + 1))
      throw new BuildError("inputTooLarge", 413);
    if (this.native && this.size >= RESOURCE_FRAME_HEADER && this.expected === null)
      this.expected = resourceFrameSize(this.prefix);
    if (this.expected !== null && this.size > this.expected) throw new BuildError("invalidResourceBuild");
    this.chunks.push(new Uint8Array(value));
    this.complete = this.native ? this.size === this.expected : value.includes(10);
    return this.complete;
  }
  async result(): Promise<ExecutionInput> {
    if (!this.complete) throw new BuildError("missingInput");
    const bytes = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return this.native
      ? decodeResourceBuild(bytes)
      : buildInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
}
