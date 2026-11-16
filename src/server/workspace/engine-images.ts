import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { inside } from "../path-utils.js";
import { attachmentImageType } from "./attachments.js";
import { LOCAL_IMAGE_MAX_BYTES, resolveLocalImage } from "./images.js";
import { createImageThumbnailCache } from "./image-thumbnails.js";

type Read = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** Only native viewed-image references can issue a signed, read-only image capability. */
export class EngineImages {
  private readonly secret: Buffer;
  private readonly pending = new Map<string, Promise<Buffer>>();
  private readonly thumbnail = createImageThumbnailCache();
  private lastPrune = 0;
  constructor(
    private readonly root: string,
    private readonly roots: string[],
    private readonly read: Read,
    private readonly now = Date.now,
    signingKey?: string,
  ) {
    this.secret = signingKey
      ? createHmac("sha256", signingKey)
          .update("panda-force/engine-images/v1:" + root)
          .digest()
      : randomBytes(32);
  }
  reference(path: unknown, view: unknown) {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      path.length > 8192 ||
      path.includes("\0") ||
      typeof view !== "string" ||
      !view ||
      view.length > 512
    )
      return null;
    const normalized = resolve(path);
    if (!this.roots.some((root) => inside(normalized, resolve(root)))) return null;
    const payload = Buffer.from(
      JSON.stringify({ path: normalized, view, expires: Math.ceil(this.now() / 3600000) * 3600000 + 7 * 86400000 }),
    ).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return (
      "/api/images/engine?token=" + payload + "." + signature + "&name=" + encodeURIComponent(basename(normalized))
    );
  }
  private verify(token: string) {
    if (token.length > 16384) throw Error("Invalid image reference");
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw Error("Invalid image reference");
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error("Invalid image reference");
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof value.expires !== "number" || value.expires < this.now() || !this.reference(value.path, value.view))
      throw Error("Expired image reference");
    return {
      path: value.path as string,
      key: createHash("sha256")
        .update(JSON.stringify([value.path, value.view]))
        .digest("hex"),
    };
  }
  private async content(path: string, key: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, key);
    try {
      const info = await stat(target);
      if (info.isFile() && info.size <= LOCAL_IMAGE_MAX_BYTES) return await readFile(target);
    } catch {}
    const metadata = (await this.read("fs/getMetadata", { path })) as { isFile?: boolean; isSymlink?: boolean };
    if (!metadata.isFile || metadata.isSymlink) throw Error("Image unavailable");
    const result = (await this.read("fs/readFile", { path })) as { dataBase64?: unknown };
    if (
      typeof result.dataBase64 !== "string" ||
      result.dataBase64.length > Math.ceil(LOCAL_IMAGE_MAX_BYTES / 3) * 4 + 4
    )
      throw Error("Image too large");
    const bytes = Buffer.from(result.dataBase64, "base64");
    if (!bytes.length || bytes.length > LOCAL_IMAGE_MAX_BYTES || !attachmentImageType(bytes.subarray(0, 16)))
      throw Error("Unsupported image bytes");
    const temporary = target + "." + randomUUID();
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    await this.prune().catch(() => {});
    return bytes;
  }
  private async prune() {
    if (this.now() - this.lastPrune < 60000) return;
    this.lastPrune = this.now();
    const entries = await Promise.all(
      (await readdir(this.root))
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .map(async (name) => ({ path: join(this.root, name), info: await stat(join(this.root, name)) })),
    );
    entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    let bytes = 0;
    for (const [index, entry] of entries.entries()) {
      bytes += entry.info.size;
      if (index >= 256 || bytes > 512 * 1024 * 1024 || this.now() - entry.info.mtimeMs > 7 * 86400000)
        await unlink(entry.path).catch(() => {});
    }
  }
  async image(token: string, thumbnail = false) {
    const { path, key } = this.verify(token);
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 4) throw Object.assign(Error("Image queue is full"), { status: 503 });
      pending = this.content(path, key);
      this.pending.set(key, pending);
    }
    let bytes: Buffer;
    try {
      bytes = await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
    const type = attachmentImageType(bytes.subarray(0, 16));
    if (!type) throw Error("Unsupported image bytes");
    if (thumbnail) {
      const image = resolveLocalImage(join(this.root, key), { allowedRoots: [this.root] });
      return { bytes: await this.thumbnail(image), type: "image/webp" };
    }
    return { bytes, type };
  }
}
