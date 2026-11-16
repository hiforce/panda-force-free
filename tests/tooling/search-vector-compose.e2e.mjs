import assert from "node:assert/strict";
import { sealedVectorProof } from "../support/sealed-vector-proof.js";
import { cachedVectorRuntimeProof } from "../support/search-cached-vector-proof.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const image = process.env.PANDA_FORCE_MILVUS_TEST_IMAGE;
if (!image) throw Error("Set PANDA_FORCE_MILVUS_TEST_IMAGE to an explicitly selected local Milvus image.");
const project = "panda-vector-test-" + randomUUID().slice(0, 8),
  out = resolve(".artifacts/search-vector-compose", project),
  password = randomBytes(32).toString("hex"),
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PANDA_FORCE_|COMPOSE_)/.test(key)));
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(resolve(out, "password"), password + "\n", { mode: 0o600 });
Object.assign(env, {
  PANDA_FORCE_MILVUS_IMAGE: image,
  PANDA_FORCE_MILVUS_PULL_POLICY: "never",
  PANDA_FORCE_MILVUS_PASSWORD_FILE: resolve(out, "password"),
  PANDA_FORCE_MILVUS_PORT: "0",
});
const compose = [
  "docker",
  "compose",
  "--env-file",
  "/dev/null",
  "-p",
  project,
  "-f",
  resolve("docker-compose.search.yml"),
];
function command(args, overrides = {}) {
  const result = Bun.spawnSync([...compose, ...args], {
    env: { ...env, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240000,
  });
  if (result.exitCode) throw Error("Compose operation failed: " + args[0]);
  return result.stdout.toString().trim();
}
const config = JSON.parse(
  command(["config", "--format", "json"], {
    PANDA_FORCE_MILVUS_IMAGE: "registry.example.test/team/vector:reviewed",
    PANDA_FORCE_MILVUS_PULL_POLICY: "never",
  }),
);
assert.equal(config.services["panda-milvus"].image, "registry.example.test/team/vector:reviewed");
assert.equal(config.services["panda-milvus"].pull_policy, "never");
assert.equal(config.services["panda-milvus"].volumes[0].type, "volume");
assert.equal(config.services["panda-milvus"].ports.length, 1);
assert.equal(config.services["panda-milvus"].ports[0].host_ip, "127.0.0.1");
assert.equal(config.services["panda-milvus"].ports[0].target, 19530);
assert.equal(JSON.stringify(config).includes(password), false);
let cleaned = false;
function cleanup() {
  if (!cleaned) {
    cleaned = true;
    command(["down", "-v", "--remove-orphans"]);
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cleanup();
    process.exit(1);
  });
try {
  command(["up", "-d", "--wait", "--wait-timeout", "180"]);
  let endpoint = "http://" + command(["port", "panda-milvus", "19530"]);
  const collectionName = "panda_fixture_" + randomBytes(12).toString("hex");
  let requests = 0;
  async function request(path, body, authenticated = true) {
    requests++;
    const response = await fetch(endpoint + "/v2/vectordb/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: "Bearer root:" + password } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error("Storage HTTP " + response.status);
    const result = await response.json();
    if (result.code !== 0) throw Error("Storage code " + result.code);
    return result.data;
  }
  await assert.rejects(request("collections/list", {}, false));
  await request("collections/create", {
    collectionName,
    dimension: 4,
    metricType: "COSINE",
    idType: "VarChar",
    autoID: false,
    primaryFieldName: "id",
    vectorFieldName: "vector",
    params: { max_length: 128, enableDynamicField: true, consistencyLevel: "Strong" },
  });
  const rows = [
    {
      id: "a".repeat(64),
      knowledge: "fixture-a",
      version: "v1",
      text: "Durable synthetic knowledge.",
      vector: [0.1, 0.2, 0.3, 0.4],
    },
    {
      id: "f".repeat(64),
      knowledge: "fixture-b",
      version: "v1",
      text: "Another synthetic record.",
      vector: [0.4, 0.3, 0.2, 0.1],
    },
  ];
  await request("entities/insert", { collectionName, data: rows });
  const count = () =>
    request("entities/query", { collectionName, filter: "", outputFields: ["count(*)"], consistencyLevel: "Strong" });
  assert.deepEqual(await count(), [{ "count(*)": 2 }]);
  const read = () =>
    request("entities/query", {
      collectionName,
      filter: 'id like "a%"',
      outputFields: ["id", "knowledge", "version", "text", "vector"],
      limit: 4,
      consistencyLevel: "Strong",
    });
  assert.deepEqual(await read(), [rows[0]]);
  const nearest = await request("entities/search", {
    collectionName,
    data: [rows[0].vector],
    annsField: "vector",
    limit: 2,
    outputFields: ["knowledge", "version"],
    consistencyLevel: "Strong",
  });
  assert.equal(nearest[0].knowledge, rows[0].knowledge);
  rows[0] = { ...rows[0], version: "v2", text: "Updated saved knowledge." };
  await request("entities/upsert", { collectionName, data: [rows[0]] });
  assert.deepEqual(await read(), [rows[0]]);
  command(["restart", "panda-milvus"]);
  // Docker may reassign an ephemeral host port on restart; application service DNS remains stable.
  endpoint = "http://" + command(["port", "panda-milvus", "19530"]);
  const deadline = Date.now() + 120000;
  while (true) {
    try {
      await request("collections/load", { collectionName });
      assert.deepEqual(await count(), [{ "count(*)": 2 }]);
      assert.deepEqual(await read(), [rows[0]]);
      break;
    } catch (error) {
      const reconnecting =
        error instanceof Error &&
        (("code" in error && /^(ConnectionRefused|ECONNREFUSED|ECONNRESET)$/.test(String(error.code))) ||
          /^Storage (?:HTTP|code) 503/.test(error.message));
      if (!reconnecting || Date.now() > deadline) throw error;
      await Bun.sleep(1000);
    }
  }
  await request("collections/drop", { collectionName });
  assert.deepEqual(await request("collections/has", { collectionName }), { has: false });
  const sealed = await sealedVectorProof({
    endpoint: () => endpoint,
    password,
    root: resolve(out, "seals"),
    restart: async () => {
      command(["restart", "panda-milvus"]);
      endpoint = "http://" + command(["port", "panda-milvus", "19530"]);
    },
  });
  const cache = await cachedVectorRuntimeProof({ endpoint, password, root: resolve(out, "cached-runtime") });
  writeFileSync(
    resolve(out, "verified.private.json"),
    JSON.stringify(
      {
        passed: true,
        image,
        authenticated: true,
        administratorImageAndPullPolicyOverride: true,
        namedVolumeRestart: true,
        strongImmediateReads: true,
        prefixQuery: true,
        syntheticNearestVector: true,
        retainedUpdatedRecord: true,
        disposableRequests: requests,
        embeddingRequests: sealed.syntheticEmbeddingRequests,
        paidInference: false,
        sealed,
        cache,
        productionChanged: false,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "Optional vector Compose storage, authentication, saved vectors and restart and sealed adapter verified; no paid model inference.",
  );
} finally {
  cleanup();
}
