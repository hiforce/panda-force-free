import { SKILL_LIMITS } from "../../../shared/skills/contracts.js";
import { SkillRegistryError } from "../errors.js";

/** Retain only verified cover bytes, not complete archives or installation permissions. */
export class SkillArtworkCache {
  private readonly cached = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private bytes = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  async read(key: string, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const cached = this.cached.get(key);
    if (cached) {
      this.cached.delete(key);
      this.cached.set(key, cached);
      return new Uint8Array(cached);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 16) throw new SkillRegistryError("unavailable");
      pending = Promise.resolve().then(() => this.load(key, load));
      this.pending.set(key, pending);
    }
    return new Uint8Array(await pending);
  }
  private async load(key: string, load: () => Promise<Uint8Array>) {
    if (this.active >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const source = await load();
      if (!source.length || source.length > SKILL_LIMITS.fileBytes) throw new SkillRegistryError("unavailable");
      const bytes = new Uint8Array(source);
      while (this.cached.size && (this.cached.size >= 32 || this.bytes + bytes.length > 8 * 1024 * 1024)) {
        const oldest = this.cached.keys().next().value!;
        this.bytes -= this.cached.get(oldest)!.length;
        this.cached.delete(oldest);
      }
      this.cached.set(key, bytes);
      this.bytes += bytes.length;
      return bytes;
    } finally {
      this.pending.delete(key);
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
