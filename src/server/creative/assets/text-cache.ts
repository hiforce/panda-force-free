import { createHash } from "node:crypto";
import type { CreativeAssetKind } from "../../../shared/creative/assets.js";
import type { CreativeText } from "./text.js";
import type { CreativePreviewResource } from "./preview-resources.js";

/** Only pure parser output is reused. Callers still authorize and verify original/resource bytes before extraction. */
export class CreativeTextCache {
  private readonly values = new Map<string, { value: CreativeText; bytes: number }>();
  private bytes = 0;
  constructor(
    private readonly maximumBytes = 16 * 1024 * 1024,
    private readonly maximumEntries = 32,
  ) {}
  key(
    kind: CreativeAssetKind,
    name: string,
    bytes: Uint8Array,
    preview: boolean,
    resources: readonly CreativePreviewResource[] = [],
  ) {
    const hash = createHash("sha256")
      .update(JSON.stringify(["creative-text/2", kind, name, preview]))
      .update(bytes);
    if (preview)
      for (const file of [...resources].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
        hash.update(JSON.stringify([file.name, file.bytes.length])).update(file.bytes);
    return hash.digest("hex");
  }
  get(key: string) {
    const value = this.values.get(key);
    if (!value) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return structuredClone(value.value);
  }
  put(key: string, value: CreativeText) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > Math.min(this.maximumBytes, 2 * 1024 * 1024)) return;
    const previous = this.values.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.values.delete(key);
    }
    this.values.set(key, { value: structuredClone(value), bytes });
    this.bytes += bytes;
    while (this.bytes > this.maximumBytes || this.values.size > this.maximumEntries) {
      const oldest = this.values.keys().next().value!;
      this.bytes -= this.values.get(oldest)!.bytes;
      this.values.delete(oldest);
    }
  }
  clear() {
    this.values.clear();
    this.bytes = 0;
  }
}
