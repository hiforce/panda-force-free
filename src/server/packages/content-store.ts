import { mkdir, open, link, unlink, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { errorCode } from "../../shared/errors.js";
import { readPackageFile, PackageContentError } from "./file-bytes.js";
export { PackageContentError } from "./file-bytes.js";

export interface PackageContentCodec<T> {
  readonly maxBytes: number;
  readonly extension?: ".json" | ".source" | ".build";
  encode(value: T): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<T>;
  digest(value: T): string;
}
/** Only codecs know package semantics; this adapter owns bounded, immutable and durable file IO. */
export class FilePackageContent<T> {
  private root: string;
  private anchor: string | null = null;
  private extension: ".json" | ".source" | ".build";
  private readonly createDirectory: boolean;
  constructor(
    root: string,
    private codec: PackageContentCodec<T>,
    options: { createDirectory?: boolean } = {},
  ) {
    this.root = resolve(root);
    this.createDirectory = options.createDirectory !== false;
    this.extension = codec.extension ?? ".json";
    if (![".json", ".source", ".build"].includes(this.extension)) throw new PackageContentError("invalidFormat");
  }
  private async directory(): Promise<string> {
    if (this.createDirectory) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root),
      path = await realpath(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (this.anchor !== null && this.anchor !== path))
      throw new PackageContentError("contentUnavailable");
    this.anchor = path;
    return path;
  }
  private target(root: string, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new PackageContentError("invalidDigest");
    return join(root, digest + this.extension);
  }
  async put(value: T): Promise<void> {
    const digest = this.codec.digest(value),
      bytes = new Uint8Array(await this.codec.encode(value));
    if (bytes.length > this.codec.maxBytes) throw new PackageContentError("contentUnavailable");
    const checked = await this.codec.decode(new Uint8Array(bytes));
    if (this.codec.digest(checked) !== digest) throw new PackageContentError("contentChanged");
    const root = await this.directory(),
      target = this.target(root, digest),
      temporary = join(root, `${digest}.${randomUUID()}.tmp`),
      file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        await this.read(digest);
      }
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary);
    }
  }
  async read(digest: string): Promise<T> {
    return (await this.readSized(digest)).value;
  }
  async readSized(digest: string): Promise<{ value: T; bytes: number }> {
    const root = await this.directory(),
      bytes = await readPackageFile(this.target(root, digest), this.codec.maxBytes);
    const value = await this.codec.decode(bytes);
    if (this.codec.digest(value) !== digest) throw new PackageContentError("contentUnavailable");
    return { value, bytes: bytes.length };
  }
}
