import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { readPackageFile, PackageContentError } from "../../packages/file-bytes.js";
import { CreationError } from "../contracts.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../validation.js";
import { attachmentImageType } from "../../workspace/attachments.js";

const maximumBytes = 8 * 1024 * 1024;
const textBytes = 2 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
interface Intent {
  schema: 1;
  owner: string;
  id: string;
  directory: string;
  filename: string;
  digest: string;
  bytes: number;
}
export interface CreationFileReceipt {
  path: string;
  digest: string;
  bytes: number;
}
/** Only an application authorization adapter can supply this directory; model text is never a directory grant. */
export interface CreationFileDirectory {
  readonly path: string;
  verify(): Promise<void>;
}
function intent(value: unknown): Intent {
  const row = creationRecord(value, ["schema", "owner", "id", "directory", "filename", "digest", "bytes"]),
    directory = creationText(row.directory, 4096),
    filename = creationText(row.filename, 240),
    bytes = creationInteger(row.bytes);
  if (
    row.schema !== 1 ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    !filename ||
    Buffer.byteLength(filename) > 240 ||
    filename === "." ||
    filename === ".." ||
    /[/\\:\p{Cc}]/u.test(filename) ||
    (!/\.(?:md|markdown|txt)$/i.test(filename) && !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(filename)) ||
    (/\.(?:md|markdown|txt)$/i.test(filename) && bytes > textBytes) ||
    bytes > maximumBytes
  )
    throw new CreationError("invalidInput");
  return {
    schema: 1,
    owner: creationText(row.owner, 200),
    id: creationUuid(row.id),
    directory,
    filename,
    digest: creationDigest(row.digest),
    bytes,
  };
}
const key = (value: Pick<Intent, "owner" | "id">) =>
  hash(stableJson({ purpose: "creation-authored-file", owner: value.owner, id: value.id }));
export function creationDocumentFilename(title: string, id: string) {
  const suffix = "-" + creationUuid(id).slice(0, 8) + ".md";
  let name = "";
  for (const character of creationText(title, 200)
    .normalize("NFC")
    .replace(/[/\\:\p{Cc}]/gu, " ")
    .trim()) {
    if (Buffer.byteLength(name + character + suffix) > 220) break;
    name += character;
  }
  return (name.replace(/^[. ]+|[. ]+$/g, "") || "document") + suffix;
}
const request = (value: Intent) => hash(stableJson(value));
async function present(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function optional<T>(store: FilePackageContent<T>, id: string) {
  try {
    return await store.read(id);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** First-writer intents and hard-link publication recover an interrupted write without adopting or replacing user files. */
export class CreationAuthoredFiles {
  private readonly intents: FilePackageContent<Intent>;
  private readonly receipts: FilePackageContent<Intent>;
  private readonly pending = new Map<string, { request: string; work: Promise<CreationFileReceipt> }>();
  constructor(root: string) {
    const codec = {
      maxBytes: 16384,
      encode: async (value: Intent) => Buffer.from(stableJson(intent(value))),
      decode: async (bytes: Uint8Array) => intent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: key,
    };
    this.intents = new FilePackageContent<Intent>(join(root, "intents"), codec);
    this.receipts = new FilePackageContent<Intent>(join(root, "receipts"), codec);
  }
  write(owner: string, id: string, directory: CreationFileDirectory, filename: string, markdown: string) {
    if (
      typeof markdown !== "string" ||
      !markdown.trim() ||
      markdown.includes("\0") ||
      !/\.(md|markdown|txt)$/i.test(filename)
    )
      return Promise.reject(new CreationError("invalidInput"));
    return this.writeBytes(owner, id, directory, filename, Buffer.from(markdown));
  }
  writeImage(owner: string, id: string, directory: CreationFileDirectory, filename: string, input: Uint8Array) {
    const bytes = Buffer.from(input),
      mime = attachmentImageType(bytes),
      extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[
        mime || ""
      ];
    if (!extension || !bytes.length || bytes.length > maximumBytes || filename !== hash(bytes) + "." + extension)
      return Promise.reject(new CreationError("invalidInput"));
    return this.writeBytes(owner, id, directory, filename, bytes);
  }
  private writeBytes(owner: string, id: string, directory: CreationFileDirectory, filename: string, bytes: Uint8Array) {
    const value = intent({
      schema: 1,
      owner,
      id,
      directory: directory.path,
      filename,
      digest: hash(bytes),
      bytes: bytes.length,
    });
    const identity = key(value),
      signature = request(value),
      active = this.pending.get(identity);
    if (active) {
      if (active.request !== signature) return Promise.reject(new CreationError("conflict"));
      return (async () => {
        await this.directory(value, directory);
        const receipt = await active.work;
        await this.directory(value, directory);
        return receipt;
      })();
    }
    const work = this.publish(value, bytes, directory)
      .catch(async (error) => {
        if (!missing(error)) throw error;
        const completed = await optional(this.receipts, identity);
        if (!completed || request(completed) !== signature) throw error;
        await this.directory(value, directory);
        const receipt = await this.inspect(value);
        await this.directory(value, directory);
        return receipt;
      })
      .finally(() => this.pending.delete(identity));
    this.pending.set(identity, { request: signature, work });
    return work;
  }
  private async directory(value: Intent, directory: CreationFileDirectory) {
    await directory.verify();
    const info = await lstat(value.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(value.directory)) !== value.directory)
      throw new CreationError("unavailable");
  }
  private async inspect(value: Intent) {
    const path = join(value.directory, value.filename),
      bytes = await readPackageFile(path, value.bytes).catch((error) => {
        if (error instanceof PackageContentError) return null;
        throw error;
      });
    if (!bytes || bytes.length !== value.bytes || hash(bytes) !== value.digest) throw new CreationError("conflict");
    return { path, digest: value.digest, bytes: value.bytes };
  }
  private async publish(value: Intent, bytes: Uint8Array, directory: CreationFileDirectory) {
    await this.directory(value, directory);
    const identity = key(value),
      path = join(value.directory, value.filename),
      prepared = join(value.directory, ".panda-authored-" + identity + ".tmp");
    const prior = await optional(this.intents, identity);
    if (prior && request(prior) !== request(value)) throw new CreationError("conflict");
    if (!prior && (await present(path))) throw new CreationError("conflict");
    await this.intents.put(value);
    if (request(await this.intents.read(identity)) !== request(value)) throw new CreationError("conflict");
    const completed = await optional(this.receipts, identity);
    if (completed) {
      if (request(completed) !== request(value)) throw new CreationError("conflict");
      const receipt = await this.inspect(value);
      await this.directory(value, directory);
      return receipt;
    }
    await this.directory(value, directory);
    try {
      const file = await open(
        prepared,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const staged = await readPackageFile(prepared, value.bytes);
      if (staged.length !== value.bytes || hash(staged) !== value.digest) throw new CreationError("unavailable");
    }
    await this.directory(value, directory);
    try {
      await link(prepared, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const [targetInfo, preparedInfo] = await Promise.all([
      lstat(path, { bigint: true }),
      lstat(prepared, { bigint: true }),
    ]);
    if (
      !targetInfo.isFile() ||
      targetInfo.isSymbolicLink() ||
      targetInfo.dev !== preparedInfo.dev ||
      targetInfo.ino !== preparedInfo.ino
    )
      throw new CreationError("conflict");
    await syncDirectory(value.directory);
    const receipt = await this.inspect(value);
    await this.directory(value, directory);
    await this.receipts.put(value);
    if (request(await this.receipts.read(identity)) !== request(value)) throw new CreationError("conflict");
    await unlink(prepared);
    await syncDirectory(value.directory);
    return receipt;
  }
}
