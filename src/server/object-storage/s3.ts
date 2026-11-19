import type { S3Connection, S3Credentials, S3ObjectReceipt } from "./contracts.js";
import { ObjectStorageError } from "./contracts.js";
import { s3Query, s3UriEncode, signS3Headers, signS3Download, storageSha256 } from "./sigv4.js";

const maximum = 32 * 1024 * 1024;
export type S3Transport = (url: URL, options: RequestInit) => Promise<Response>;
const invalid = () => {
  throw new ObjectStorageError("storageInvalidConfiguration");
};
function checkedText(value: string, limit: number, empty = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!empty && !value.length) ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  )
    invalid();
  return value;
}
export function validateS3Connection(value: S3Connection): S3Connection {
  const region = checkedText(value.region, 64),
    bucket = checkedText(value.bucket, 63);
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(region) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    bucket.endsWith("--x-s3") ||
    typeof value.forcePathStyle !== "boolean"
  )
    invalid();
  let url: URL;
  try {
    url = new URL(checkedText(value.endpoint, 2048));
  } catch {
    return invalid();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    invalid();
  if (!value.forcePathStyle && (url.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(url.hostname))) invalid();
  return { endpoint: url.origin, region, bucket, forcePathStyle: value.forcePathStyle };
}
export function validateS3Credentials(value: S3Credentials) {
  checkedText(value.accessKeyId, 256);
  checkedText(value.secretAccessKey, 2048);
  if (!/^[A-Za-z0-9_-]+$/.test(value.accessKeyId)) invalid();
  if (value.sessionToken !== undefined) checkedText(value.sessionToken, 16384);
  return { ...value };
}
function version(value: string) {
  checkedText(value, 2048);
  if (!/^[\x21-\x7e]+$/.test(value)) invalid();
  return value;
}
function receipt(response: Response, logicalSize?: number): S3ObjectReceipt {
  const declared = response.headers.get("content-length"),
    size = logicalSize ?? Number(declared),
    etag = response.headers.get("etag") ?? "",
    digest = response.headers.get("x-amz-meta-panda-digest") ?? "",
    intentId = response.headers.get("x-amz-meta-panda-intent") ?? "",
    versionId = response.headers.get("x-amz-version-id") ?? "null";
  if (
    declared === null ||
    !/^\d+$/.test(declared) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > maximum ||
    !/^"[A-Za-z0-9._-]{1,128}"$/.test(etag) ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !/^[a-f0-9-]{36}$/.test(intentId)
  )
    throw new ObjectStorageError("storageIntegrity");
  return { size, etag, digest, intentId, versionId: version(versionId) };
}
function sameObject(value: S3ObjectReceipt, expected: S3ObjectReceipt) {
  return (
    value.versionId === expected.versionId &&
    value.etag === expected.etag &&
    value.digest === expected.digest &&
    value.intentId === expected.intentId &&
    value.size === expected.size
  );
}
async function boundedBody(response: Response, limit: number, signal: AbortSignal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new ObjectStorageError("storageTooLarge");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ObjectStorageError("storageUnavailable", true);
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new ObjectStorageError("storageTooLarge");
      chunks.push(part.value);
    }
    if (signal.aborted) throw new ObjectStorageError("storageUnavailable", true);
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** No ambient credentials, redirects, ACL operations, listing or automatic retries; the durable journal owns replay. */
export class PrivateS3Client {
  readonly connection: S3Connection;
  #credentials: S3Credentials;
  constructor(
    connection: S3Connection,
    credentials: S3Credentials,
    private readonly transport: S3Transport = fetch,
  ) {
    this.connection = Object.freeze(validateS3Connection(connection));
    this.#credentials = validateS3Credentials(credentials);
  }
  private url(key: string, versionId?: string) {
    checkedText(key, 1024);
    if (key.split("/").some((part) => !part || part === "." || part === "..") || key.includes("\\")) invalid();
    const url = new URL(this.connection.endpoint);
    if (!this.connection.forcePathStyle) url.hostname = this.connection.bucket + "." + url.hostname;
    url.pathname =
      "/" +
      [...(this.connection.forcePathStyle ? [this.connection.bucket] : []), ...key.split("/")]
        .map(s3UriEncode)
        .join("/");
    if (versionId !== undefined) url.search = s3Query([["versionId", version(versionId)]]);
    return url;
  }
  private async request(
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    key: string,
    options: {
      versionId?: string;
      headers?: Record<string, string>;
      body?: Uint8Array;
      signal?: AbortSignal;
    } = {},
  ) {
    const url = this.url(key, options.versionId),
      body = new Uint8Array(options.body ?? []),
      signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]),
      headers = signS3Headers({
        method,
        url,
        region: this.connection.region,
        credentials: this.#credentials,
        payload: body,
        headers: options.headers,
      });
    let response: Response;
    try {
      response = await this.transport(url, {
        method,
        headers,
        body: method === "PUT" ? body : undefined,
        redirect: "error",
        signal,
      });
    } catch {
      throw new ObjectStorageError("storageUnavailable", true);
    }
    if (![200, 204, 206, 404, 412].includes(response.status)) {
      await response.body?.cancel();
      throw new ObjectStorageError(
        [401, 403].includes(response.status)
          ? "storageDenied"
          : response.status === 409
            ? "storageConflict"
            : "storageUnavailable",
        response.status === 429 || response.status >= 500 || response.status === 409,
        response.status,
      );
    }
    return { response, signal };
  }
  downloadUrl(
    key: string,
    expected: S3ObjectReceipt,
    input: { mime: string; name: string; attachment: boolean },
    date = new Date(),
    expiresSeconds = 86400,
  ) {
    checkedText(input.mime, 128);
    checkedText(input.name, 512);
    const url = this.url(key, expected.versionId);
    url.searchParams.set("response-content-type", input.mime);
    url.searchParams.set("response-cache-control", "private, no-store");
    url.searchParams.set(
      "response-content-disposition",
      (input.attachment ? "attachment" : "inline") + "; filename*=UTF-8''" + s3UriEncode(input.name),
    );
    return signS3Download({
      url,
      region: this.connection.region,
      credentials: this.#credentials,
      date,
      expiresSeconds,
    });
  }
  async head(key: string, versionId?: string, signal?: AbortSignal): Promise<S3ObjectReceipt | null> {
    const result = await this.request("HEAD", key, { versionId, signal });
    if (result.response.status === 404) return null;
    if (result.response.status !== 200) throw new ObjectStorageError("storageIntegrity");
    return receipt(result.response);
  }
  async put(key: string, bytes: Uint8Array, intentId: string, signal?: AbortSignal) {
    if (bytes.length > maximum) throw new ObjectStorageError("storageTooLarge");
    if (!/^[a-f0-9-]{36}$/.test(intentId)) invalid();
    const result = await this.request("PUT", key, {
      signal,
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "if-none-match": "*",
        "x-amz-meta-panda-digest": storageSha256(bytes),
        "x-amz-meta-panda-intent": intentId,
      },
    });
    await result.response.body?.cancel();
    if (result.response.status === 412) return { state: "exists" as const };
    if (result.response.status === 404) throw new ObjectStorageError("storageUnavailable", false, 404);
    if (result.response.status !== 200) throw new ObjectStorageError("storageIntegrity");
    const versionId = version(result.response.headers.get("x-amz-version-id") ?? "null"),
      etag = result.response.headers.get("etag") ?? "";
    if (!/^"[A-Za-z0-9._-]{1,128}"$/.test(etag)) throw new ObjectStorageError("storageIntegrity");
    return { state: "written" as const, versionId, etag };
  }
  async get(key: string, expected: S3ObjectReceipt, signal?: AbortSignal, range?: { start: number; end: number }) {
    if (
      range &&
      (!Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end >= expected.size)
    )
      invalid();
    const result = await this.request("GET", key, {
      versionId: expected.versionId,
      signal,
      headers: {
        "if-match": expected.etag,
        ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}),
      },
    });
    if (result.response.status !== (range ? 206 : 200)) {
      await result.response.body?.cancel();
      throw new ObjectStorageError("storageIntegrity");
    }
    const length = range ? range.end - range.start + 1 : expected.size,
      info = receipt(result.response, range ? expected.size : undefined);
    if (
      !sameObject(info, expected) ||
      (range && result.response.headers.get("content-range") !== `bytes ${range.start}-${range.end}/${expected.size}`)
    ) {
      await result.response.body?.cancel();
      throw new ObjectStorageError("storageIntegrity");
    }
    const bytes = await boundedBody(result.response, length, result.signal);
    if (bytes.length !== length || (!range && storageSha256(bytes) !== expected.digest))
      throw new ObjectStorageError("storageIntegrity");
    return bytes;
  }
  async delete(key: string, expected: S3ObjectReceipt, signal?: AbortSignal) {
    const current = await this.head(key, expected.versionId, signal);
    if (!current) return;
    if (!sameObject(current, expected)) throw new ObjectStorageError("storageIntegrity");
    // Delete the verified immutable key's exact version, including null after bucket versioning changes.
    // AWS rejects combining If-Match with versionId; never fall back to deleting the current object.
    const result = await this.request("DELETE", key, {
      versionId: expected.versionId,
      signal,
    });
    await result.response.body?.cancel();
    if (![200, 204, 404].includes(result.response.status)) throw new ObjectStorageError("storageConflict");
  }
}
