import { DOMParser } from "@xmldom/xmldom";
import { ObjectStorageError } from "./contracts.js";
import { storageSha256 } from "./sigv4.js";

export const s3MultipartPartBytes = 5 * 1024 * 1024;
const maxObjectBytes = 1024 * 1024 * 1024;

export interface S3MultipartObject {
  versionId: string;
  etag: string;
  size: number;
  intent: string;
}

type Request = (
  method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE",
  key: string | null,
  options?: {
    query?: Record<string, string>;
    versionId?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) => Promise<{ response: Response; signal: AbortSignal }>;

const integrity = (): never => {
  throw new ObjectStorageError("storageIntegrity");
};
const token = (value: string | null) => {
  if (!value || !/^[\x21-\x7e]{1,2048}$/u.test(value)) return integrity();
  return value;
};
const etag = (value: string | null) => {
  if (!value || !/^"[a-zA-Z0-9._-]{1,128}"$/u.test(value)) return integrity();
  return value;
};
const queryFor = (uploadId: string) => ({ uploadId: token(uploadId) });

function object(response: Response, length: number): S3MultipartObject {
  const intent = response.headers.get("x-amz-meta-panda-intent");
  if (!intent || !/^[a-f0-9-]{36}$/u.test(intent) || length < 0 || length > maxObjectBytes) return integrity();
  return {
    versionId: token(response.headers.get("x-amz-version-id") ?? "null"),
    etag: etag(response.headers.get("etag")),
    intent,
    size: length,
  };
}

export function s3Multipart(
  request: Request,
  boundedBody: (response: Response, limit: number, signal: AbortSignal) => Promise<Uint8Array>,
) {
  async function xml(result: Awaited<ReturnType<Request>>, root: string) {
    if (result.response.status !== 200) {
      await result.response.body?.cancel();
      throw new ObjectStorageError("storageUnavailable", true, result.response.status);
    }
    const data = new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBody(result.response, 256 * 1024, result.signal),
    );
    if (/<!DOCTYPE|<!ENTITY/iu.test(data)) return integrity();
    let parsed;
    try {
      parsed = new DOMParser({ onError: () => integrity() }).parseFromString(
        data.trim(),
        "application/xml",
      ).documentElement;
    } catch {
      return integrity();
    }
    if (parsed?.localName === "Error") throw new ObjectStorageError("storageUnavailable", true);
    if (parsed?.localName !== root) return integrity();
    return parsed;
  }
  const text = (element: ReturnType<DOMParser["parseFromString"]>["documentElement"], name: string) =>
    element?.getElementsByTagNameNS("*", name).item(0)?.textContent ?? null;
  async function head(key: string, versionId?: string, signal?: AbortSignal) {
    const { response } = await request("HEAD", key, { versionId, signal });
    if (response.status === 404) return null;
    const length = response.headers.get("content-length");
    if (response.status !== 200 || !length || !/^\d{1,10}$/u.test(length)) return integrity();
    return object(response, Number(length));
  }
  return {
    async start(key: string, intent: string, signal?: AbortSignal) {
      const result = await request("POST", key, {
        query: { uploads: "" },
        headers: {
          "x-amz-meta-panda-intent": intent,
          "content-type": "application/octet-stream",
          "cache-control": "private, no-store",
        },
        signal,
      });
      return token(text(await xml(result, "InitiateMultipartUploadResult"), "UploadId"));
    },
    async list(key: string, signal?: AbortSignal) {
      const result = await request("GET", null, { query: { uploads: "", prefix: key }, signal });
      const entries = await xml(result, "ListMultipartUploadsResult");
      if (text(entries, "IsTruncated") !== "false") return integrity();
      const uploads = entries.getElementsByTagNameNS("*", "Upload");
      const matches: string[] = [];
      for (let index = 0; index < uploads.length; index++) {
        const entry = uploads.item(index);
        if (text(entry, "Key") === key) matches.push(token(text(entry, "UploadId")));
      }
      return matches;
    },
    async put(key: string, uploadId: string, number: number, bytes: Uint8Array, signal?: AbortSignal) {
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        number > 10_000 ||
        !bytes.length ||
        bytes.length > s3MultipartPartBytes
      )
        return integrity();
      const result = await request("PUT", key, {
        query: { ...queryFor(uploadId), partNumber: String(number) },
        body: bytes,
        signal,
      });
      await result.response.body?.cancel();
      if (result.response.status !== 200)
        throw new ObjectStorageError("storageUnavailable", true, result.response.status);
      return etag(result.response.headers.get("etag"));
    },
    async complete(
      key: string,
      uploadId: string,
      parts: readonly string[],
      intent: string,
      size: number,
      signal?: AbortSignal,
    ) {
      const assertObject = (existing: S3MultipartObject | null) =>
        existing && existing.intent === intent && existing.size === size ? existing : integrity();
      const existing = await head(key, undefined, signal);
      if (existing) return assertObject(existing);
      const content = parts
        .map((part, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag(part)}</ETag></Part>`)
        .join("");
      const result = await request("POST", key, {
        query: queryFor(uploadId),
        body: Buffer.from("<CompleteMultipartUpload>" + content + "</CompleteMultipartUpload>"),
        headers: { "content-type": "application/xml", "if-none-match": "*" },
        signal,
        timeoutMs: 90_000,
      });
      if (result.response.status === 412 || result.response.status === 404) {
        await result.response.body?.cancel();
        return assertObject(await head(key, undefined, signal));
      }
      const responseEtag = etag(text(await xml(result, "CompleteMultipartUploadResult"), "ETag"));
      const completed = assertObject(
        await head(key, result.response.headers.get("x-amz-version-id") ?? undefined, signal),
      );
      if (completed.etag !== responseEtag) return integrity();
      return completed;
    },
    async read(
      key: string,
      objectVersion: S3MultipartObject,
      start: number,
      size: number,
      sha256: string,
      signal?: AbortSignal,
    ) {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(size) ||
        start < 0 ||
        size <= 0 ||
        size > s3MultipartPartBytes ||
        start + size > objectVersion.size
      )
        return integrity();
      const end = start + size - 1;
      const result = await request("GET", key, {
        versionId: objectVersion.versionId,
        headers: { "if-match": objectVersion.etag, range: `bytes=${start}-${end}` },
        signal,
      });
      const { response } = result;
      if (
        response.status !== 206 ||
        response.headers.get("content-range") !== `bytes ${start}-${end}/${objectVersion.size}`
      ) {
        await response.body?.cancel();
        return integrity();
      }
      const received = object(response, objectVersion.size);
      if (
        received.versionId !== objectVersion.versionId ||
        received.etag !== objectVersion.etag ||
        received.intent !== objectVersion.intent
      ) {
        await response.body?.cancel();
        return integrity();
      }
      const bytes = await boundedBody(response, size, result.signal);
      if (bytes.length !== size || storageSha256(bytes) !== sha256) return integrity();
      return bytes;
    },
    async abort(key: string, uploadId: string, signal?: AbortSignal) {
      const { response } = await request("DELETE", key, { query: queryFor(uploadId), signal });
      await response.body?.cancel();
      if (![200, 204, 404].includes(response.status)) return integrity();
    },
    async remove(key: string, intent: string, versionId?: string, signal?: AbortSignal) {
      const current = await head(key, versionId, signal);
      if (!current) return;
      if (current.intent !== intent || (versionId !== undefined && versionId !== current.versionId)) return integrity();
      const { response } = await request("DELETE", key, { versionId: current.versionId, signal });
      await response.body?.cancel();
      if (![200, 204, 404].includes(response.status)) return integrity();
    },
  };
}

export type S3Multipart = ReturnType<typeof s3Multipart>;
