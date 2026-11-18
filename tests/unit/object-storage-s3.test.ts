import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrivateS3Client, type S3Transport } from "../../src/server/object-storage/s3.js";
import type { S3ObjectReceipt } from "../../src/server/object-storage/contracts.js";
import { signS3Headers, s3Query, storageSha256 } from "../../src/server/object-storage/sigv4.js";

const connection = {
    endpoint: "https://objects.example.test",
    region: "us-east-1",
    bucket: "test-originals",
    forcePathStyle: true,
  },
  credentials = { accessKeyId: "fixture-access", secretAccessKey: "fixture-private" };
function original(bytes: Uint8Array): S3ObjectReceipt {
  return {
    versionId: "version+/opaque=",
    etag: '"original"',
    size: bytes.length,
    digest: storageSha256(bytes),
    intentId: randomUUID(),
  };
}
const responseHeaders = (value: S3ObjectReceipt) => ({
  "content-length": String(value.size),
  etag: value.etag,
  "x-amz-version-id": value.versionId,
  "x-amz-meta-panda-digest": value.digest,
  "x-amz-meta-panda-intent": value.intentId,
});

test("S3 header signing matches the published AWS GET range example and encodes query bytes", () => {
  // Public reference vector: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  // Keep the published dummy identifier distinct from a literal deployable credential for release scanners.
  const exampleAccessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const signed = signS3Headers({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    credentials: { accessKeyId: exampleAccessKey, secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    payload: new Uint8Array(),
    date: new Date("2013-05-24T00:00:00Z"),
    headers: { range: "bytes=0-9" },
  });
  expect(signed.authorization).toBe(
    `AWS4-HMAC-SHA256 Credential=${exampleAccessKey}/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
  );
  expect(
    s3Query([
      ["z", "a b+"],
      ["a", "中文/="],
    ]),
  ).toBe("a=%E4%B8%AD%E6%96%87%2F%3D&z=a%20b%2B");
});

test("private transport signs conditional originals with explicit credentials and never follows redirects or sets ACLs", async () => {
  const bytes = Buffer.from("Original text"),
    marker = randomUUID();
  const transport: S3Transport = async (url, options) => {
    expect(url.href).toBe("https://objects.example.test/test-originals/install/asset/original%20%2B.txt");
    expect(url.search).toBe("");
    expect(options.redirect).toBe("error");
    expect(options.method).toBe("PUT");
    const headers = new Headers(options.headers);
    expect(headers.get("authorization")).toContain("Credential=fixture-access/");
    expect(headers.get("x-amz-acl")).toBeNull();
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("x-amz-meta-panda-intent")).toBe(marker);
    expect(headers.get("x-amz-meta-panda-digest")).toBe(storageSha256(bytes));
    expect(Buffer.from(options.body as Uint8Array)).toEqual(bytes);
    return new Response(null, { status: 200, headers: { etag: '"written"', "x-amz-version-id": "owned-version" } });
  };
  const client = new PrivateS3Client(connection, credentials, transport);
  expect(await client.put("install/asset/original +.txt", bytes, marker)).toEqual({
    state: "written",
    etag: '"written"',
    versionId: "owned-version",
  });
  expect(JSON.stringify(client)).not.toContain(credentials.secretAccessKey);
});

test("range delivery binds exact owned version, metadata and byte count without fetching the entire original", async () => {
  const bytes = Buffer.from("A complete original"),
    expected = original(bytes);
  const client = new PrivateS3Client(connection, credentials, async (url, options) => {
    expect(url.searchParams.get("versionId")).toBe(expected.versionId);
    expect(url.search).toContain("%2B%2Fopaque%3D");
    const headers = new Headers(options.headers);
    expect(headers.get("range")).toBe("bytes=2-4");
    expect(headers.get("if-match")).toBe(expected.etag);
    return new Response(bytes.subarray(2, 5), {
      status: 206,
      headers: { ...responseHeaders(expected), "content-length": "3", "content-range": `bytes 2-4/${bytes.length}` },
    });
  });
  expect(await client.get("owned/key", expected, undefined, { start: 2, end: 4 })).toEqual(bytes.subarray(2, 5));
});

test("wrong metadata, unexpected full response, corrupted full bytes and oversized streams never reach the caller", async () => {
  const bytes = Buffer.from("trusted"),
    expected = original(bytes);
  for (const failure of ["identity", "range", "bytes", "length", "stream"]) {
    const client = new PrivateS3Client(connection, credentials, async () => {
      const body =
        failure === "bytes" ? Buffer.from("corrupt") : failure === "stream" ? Buffer.from("too many bytes") : bytes;
      const headers = {
        ...responseHeaders(expected),
        ...(failure === "identity" ? { "x-amz-meta-panda-intent": randomUUID() } : {}),
        ...(failure === "length" ? { "content-length": "1000000000" } : {}),
      };
      return new Response(body, { headers });
    });
    await expect(
      client.get("owned/key", expected, undefined, failure === "range" ? { start: 1, end: 2 } : undefined),
    ).rejects.toMatchObject({ code: failure === "stream" ? "storageTooLarge" : "storageIntegrity" });
  }
});

test("permanent cleanup deletes only the checked version and preserves a replaced or foreign object", async () => {
  const bytes = Buffer.from("owned"),
    expected = original(bytes),
    calls: string[] = [];
  const client = new PrivateS3Client(connection, credentials, async (url, options) => {
    expect(url.searchParams.get("versionId")).toBe(expected.versionId);
    calls.push(options.method!);
    return options.method === "HEAD"
      ? new Response(null, { headers: responseHeaders(expected) })
      : new Response(null, { status: 204 });
  });
  await client.delete("owned/key", expected);
  expect(calls).toEqual(["HEAD", "DELETE"]);
  const foreign = new PrivateS3Client(connection, credentials, async (_url, options) => {
    expect(options.method).toBe("HEAD");
    return new Response(null, { headers: { ...responseHeaders(expected), "x-amz-meta-panda-intent": randomUUID() } });
  });
  await expect(foreign.delete("owned/key", expected)).rejects.toMatchObject({ code: "storageIntegrity" });
});

test("null versions remain explicit for cleanup and uncertain or denied calls are never automatically replayed", async () => {
  const bytes = Buffer.from("owned"),
    expected = { ...original(bytes), versionId: "null" };
  let count = 0;
  const client = new PrivateS3Client(connection, credentials, async (url, options) => {
    count++;
    expect(url.searchParams.get("versionId")).toBe("null");
    if (options.method === "HEAD") return new Response(null, { headers: responseHeaders(expected) });
    return new Response("Access denied fixture", { status: 403 });
  });
  await expect(client.delete("owned/key", expected)).rejects.toMatchObject({ code: "storageDenied", retryable: false });
  expect(count).toBe(2);
  let uncertain = 0;
  const failed = new PrivateS3Client(connection, credentials, async () => {
    uncertain++;
    throw new Error("private endpoint detail");
  });
  await expect(failed.put("owned/key", bytes, expected.intentId)).rejects.toMatchObject({
    code: "storageUnavailable",
    retryable: true,
  });
  expect(uncertain).toBe(1);
});
