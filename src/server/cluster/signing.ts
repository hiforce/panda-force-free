import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { ClusterConfig } from "./config.js";
import type { OwnerLease } from "./contracts.js";
import { ClusterError } from "./contracts.js";

export const CLUSTER_HEADER = "x-panda-cluster-";
export interface SignedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}
export const requestDigest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const header = (headers: IncomingHttpHeaders, name: string) => (typeof headers[name] === "string" ? headers[name] : "");
function signedFields(
  request: SignedRequest,
  lease: OwnerLease,
  workspace: string,
  node: string,
  timestamp: string,
  nonce: string,
  digest: string,
) {
  const authentication = requestDigest(
    ["authorization", "cookie", "origin", "x-forwarded-for", "x-forwarded-proto"]
      .map((name) => header(request.headers, name))
      .join("\n"),
  );
  return JSON.stringify([
    workspace,
    node,
    lease.bootId,
    lease.fence,
    lease.address,
    request.method,
    request.path,
    header(request.headers, "host"),
    authentication,
    digest,
    timestamp,
    nonce,
  ]);
}
export function signClusterRequest(
  config: ClusterConfig,
  lease: OwnerLease,
  request: SignedRequest,
  body: Uint8Array,
  now = Date.now(),
) {
  const timestamp = String(now),
    nonce = randomUUID(),
    digest = requestDigest(body);
  const signature = createHmac("sha256", config.secret)
    .update(signedFields(request, lease, config.workspace, config.nodeId, timestamp, nonce, digest))
    .digest("hex");
  return Object.fromEntries(
    Object.entries({
      workspace: config.workspace,
      node: config.nodeId,
      boot: lease.bootId,
      fence: String(lease.fence),
      timestamp,
      nonce,
      body: digest,
      signature,
    }).map(([name, value]) => [CLUSTER_HEADER + name, value]),
  );
}
export function verifyClusterHead(
  config: ClusterConfig,
  lease: OwnerLease,
  request: SignedRequest,
  now = Date.now(),
): { nonce: string; digest: string } {
  const read = (name: string) => header(request.headers, CLUSTER_HEADER + name);
  const timestamp = read("timestamp"),
    nonce = read("nonce"),
    signature = read("signature"),
    digest = read("body");
  if (
    read("workspace") !== config.workspace ||
    read("boot") !== lease.bootId ||
    read("fence") !== String(lease.fence) ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(read("node")) ||
    !/^[\da-f-]{36}$/i.test(nonce) ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 30_000 ||
    !/^[\da-f]{64}$/i.test(digest) ||
    !/^[\da-f]{64}$/i.test(signature)
  )
    throw new ClusterError("Invalid internal cluster request", "cluster_request_rejected", 403);
  const expected = createHmac("sha256", config.secret)
    .update(signedFields(request, lease, config.workspace, read("node"), timestamp, nonce, digest))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new ClusterError("Invalid internal cluster signature", "cluster_request_rejected", 403);
  return { nonce, digest };
}
export function verifyClusterRequest(
  config: ClusterConfig,
  lease: OwnerLease,
  request: SignedRequest,
  body: Uint8Array,
  now = Date.now(),
): string {
  const { nonce, digest } = verifyClusterHead(config, lease, request, now);
  if (digest !== requestDigest(body))
    throw new ClusterError("Internal request body does not match its signature", "cluster_request_rejected", 403);
  return nonce;
}
