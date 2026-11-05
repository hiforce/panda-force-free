import { expect, test } from "bun:test";
import { readClusterConfig } from "../../src/server/cluster/config.js";
import { signClusterRequest, verifyClusterRequest } from "../../src/server/cluster/signing.js";
import type { OwnerLease } from "../../src/server/cluster/contracts.js";
const config = readClusterConfig({
  PANDA_FORCE_CLUSTER_ROLE: "gateway",
  PANDA_FORCE_CLUSTER_WORKSPACE: "test",
  PANDA_FORCE_CLUSTER_NODE_ID: "gateway-a",
  PANDA_FORCE_CLUSTER_DATABASE_URL: "postgres://panda@localhost/test",
  PANDA_FORCE_CLUSTER_SECRET: "test-signing-key-with-at-least-32-characters",
  PANDA_FORCE_PUBLIC_URL: "https://panda.example.test",
})!;
const lease: OwnerLease = {
  workspace: "test",
  nodeId: "owner-a",
  bootId: "boot-a",
  address: "http://owner.example.test:8899",
  fence: 2,
  expiresAt: 0,
  databaseNow: 0,
  released: false,
};
test("internal signatures bind workspace, owner generation, body, authentication, URL and deadline", () => {
  const body = Buffer.from('{"hello":"world"}');
  const request = { method: "POST", path: "/api/rpc", headers: { host: "panda.example.test", cookie: "session=one" } };
  const headers = { ...request.headers, ...signClusterRequest(config, lease, request, body) };
  expect(verifyClusterRequest(config, lease, { ...request, headers }, body)).toBeTruthy();
  expect(() => verifyClusterRequest(config, { ...lease, fence: 3 }, { ...request, headers }, body)).toThrow();
  expect(() => verifyClusterRequest({ ...config, workspace: "other" }, lease, { ...request, headers }, body)).toThrow();
  expect(() => verifyClusterRequest(config, lease, { ...request, path: "/api/other", headers }, body)).toThrow();
  expect(() =>
    verifyClusterRequest(config, lease, { ...request, headers: { ...headers, cookie: "session=other" } }, body),
  ).toThrow();
  expect(() => verifyClusterRequest(config, lease, { ...request, headers }, Buffer.from("different"))).toThrow();
  expect(() => verifyClusterRequest(config, lease, { ...request, headers }, body, Date.now() + 60_000)).toThrow();
});
test("default installation stays local and incomplete shared configurations fail", () => {
  expect(readClusterConfig({})).toBeNull();
  expect(() => readClusterConfig({ PANDA_FORCE_CLUSTER_SECRET: "configured-without-role" })).toThrow("ROLE");
  expect(() => readClusterConfig({ PANDA_FORCE_CLUSTER_ROLE: "worker" })).toThrow("PostgreSQL");
});
