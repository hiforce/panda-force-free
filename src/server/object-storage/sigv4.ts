import { createHash, createHmac } from "node:crypto";
import type { S3Credentials } from "./contracts.js";

export const storageSha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const s3UriEncode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
export function s3Query(entries: Iterable<readonly [string, string]>) {
  return [...entries]
    .map(([key, value]) => [s3UriEncode(key), s3UriEncode(value)] as const)
    .sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0))
    .map(([key, value]) => key + "=" + value)
    .join("&");
}
const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();

/** S3 signs the encoded path without normalization for server-owned transfers. */
export function signS3Headers(input: {
  method: string;
  url: URL;
  region: string;
  credentials: S3Credentials;
  payload: Uint8Array;
  headers?: Record<string, string>;
  date?: Date;
}) {
  const timestamp = (input.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, ""),
    day = timestamp.slice(0, 8),
    digest = storageSha256(input.payload),
    headers: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(input.headers ?? {})
          .filter(([name]) => name.toLowerCase() !== "authorization")
          .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")]),
      ),
      host: input.url.host,
      "x-amz-date": timestamp,
      "x-amz-content-sha256": digest,
      ...(input.credentials.sessionToken ? { "x-amz-security-token": input.credentials.sessionToken } : {}),
    };
  const names = Object.keys(headers).sort(),
    signed = names.join(";"),
    canonical = [
      input.method,
      input.url.pathname,
      s3Query(input.url.searchParams),
      names.map((name) => name + ":" + headers[name]!.trim().replace(/\s+/g, " ") + "\n").join(""),
      signed,
      digest,
    ].join("\n"),
    scope = day + "/" + input.region + "/s3/aws4_request",
    signing = hmac(
      hmac(hmac(hmac("AWS4" + input.credentials.secretAccessKey, day), input.region), "s3"),
      "aws4_request",
    ),
    signature = hmac(signing, ["AWS4-HMAC-SHA256", timestamp, scope, storageSha256(canonical)].join("\n")).toString(
      "hex",
    );
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope},SignedHeaders=${signed},Signature=${signature}`;
  return headers;
}

/** A read-only capability binds one immutable object and its response metadata. */
export function signS3Download(input: {
  url: URL;
  region: string;
  credentials: S3Credentials;
  expiresSeconds: number;
  date?: Date;
}) {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 86400)
    throw new RangeError("Invalid download lifetime");
  const url = new URL(input.url),
    timestamp = (input.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, ""),
    day = timestamp.slice(0, 8),
    scope = day + "/" + input.region + "/s3/aws4_request";
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", input.credentials.accessKeyId + "/" + scope);
  url.searchParams.set("X-Amz-Date", timestamp);
  url.searchParams.set("X-Amz-Expires", String(input.expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  if (input.credentials.sessionToken) url.searchParams.set("X-Amz-Security-Token", input.credentials.sessionToken);
  const canonical = [
      "GET",
      url.pathname,
      s3Query(url.searchParams),
      "host:" + url.host + "\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n"),
    signing = hmac(
      hmac(hmac(hmac("AWS4" + input.credentials.secretAccessKey, day), input.region), "s3"),
      "aws4_request",
    ),
    signature = hmac(signing, ["AWS4-HMAC-SHA256", timestamp, scope, storageSha256(canonical)].join("\n")).toString(
      "hex",
    );
  url.searchParams.set("X-Amz-Signature", signature);
  url.search = s3Query(url.searchParams);
  return url.href;
}
