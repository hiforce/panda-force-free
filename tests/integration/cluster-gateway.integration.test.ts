import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createPostgresFixture } from "../support/postgres-fixture.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createClusterGateway } from "../../src/server/cluster/gateway.js";
import { createPostgresCoordination } from "../../src/server/cluster/postgres.js";
import type { ClusterConfig } from "../../src/server/cluster/config.js";
import { isRecord } from "../../src/shared/records.js";

/** Two HTTP nodes share one real isolated engine owner and its persisted workspace. */
test("gateways share native sessions, attachments, event delivery and metadata without duplicating writes", async () => {
  const database = await createPostgresFixture();
  const workspace = "gateway-test-" + randomUUID(),
    secret = "disposable-cluster-signing-secret-32-characters";
  let owner: Awaited<ReturnType<typeof createAppFixture>> | undefined;
  let first: Awaited<ReturnType<typeof createClusterGateway>> | undefined, second: typeof first;
  const sockets: WebSocket[] = [];
  const audit = createPostgresCoordination(database.url);
  try {
    owner = await createAppFixture({
      extraEnvironment: ({ base }: { base: string }) => ({
        PANDA_FORCE_CLUSTER_ROLE: "worker",
        PANDA_FORCE_CLUSTER_DATABASE_URL: database.url,
        PANDA_FORCE_CLUSTER_SECRET: secret,
        PANDA_FORCE_CLUSTER_WORKSPACE: workspace,
        PANDA_FORCE_CLUSTER_NODE_ID: "owner-a",
        PANDA_FORCE_CLUSTER_NODE_URL: base,
        PANDA_FORCE_CLUSTER_STORAGE: "owner-volume",
        PANDA_FORCE_PUBLIC_URL: "http://panda.example.test",
      }),
    });
    const config: ClusterConfig = {
      role: "gateway",
      workspace,
      nodeId: "gateway-a",
      databaseUrl: database.url,
      secret,
      publicUrl: "http://panda.example.test",
      nodeUrl: null,
      leaseMs: 30_000,
      requestTimeoutMs: 30_000,
      recoverFence: null,
    };
    first = await createClusterGateway(config);
    second = await createClusterGateway({ ...config, nodeId: "gateway-b" });
    const listen = async (gateway: NonNullable<typeof first>) => {
      await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
      return "http://127.0.0.1:" + (gateway.server.address() as AddressInfo).port;
    };
    const baseA = await listen(first),
      baseB = await listen(second);
    const headers = owner.headers;
    expect((await fetch(owner.base + "/api/health", { headers })).status).toBe(403);
    const direct = new WebSocket(owner.base.replace("http", "ws") + "/ws", { headers });
    const directStatus = await new Promise<number>((resolve, reject) => {
      direct.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode || 0);
      });
      direct.once("open", () => {
        direct.close();
        reject(new Error("Owner accepted an unsigned socket"));
      });
      direct.once("error", () => {});
    });
    direct.terminate();
    expect(directStatus).toBe(403);
    expect((await fetch(baseA + "/api/health", { headers })).status).toBe(200);
    expect((await fetch(baseB + "/api/health", { headers })).status).toBe(200);
    expect((await fetch(baseA + "/api/projects")).status).toBe(401);
    const login = await fetch(baseA + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "fixture-owner", password: "visibility-test" }),
    });
    expect(login.status).toBe(200);
    const loginData = await login.json();
    let cookie = login.headers.get("set-cookie")!.split(";")[0];
    if (loginData.migrationRequired) {
      const migration = await fetch(baseB + "/api/auth/setup", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ username: "fixture-owner" }),
      });
      expect(migration.status).toBe(200);
      cookie = migration.headers.get("set-cookie")!.split(";")[0];
    }
    expect((await fetch(baseB + "/api/projects", { headers: { cookie } })).status).toBe(200);

    const operationId = randomUUID();
    const rpc = (base: string, method: string, params: object, id: number, operation = randomUUID()) =>
      fetch(base + "/api/rpc", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id, operationId: operation, method, params }),
      }).then((response) => response.json());
    const created = await rpc(baseA, "thread/start", { cwd: owner.alpha }, 1, operationId);
    const repeated = await rpc(baseB, "thread/start", { cwd: owner.alpha }, 2, operationId);
    expect(created.result.thread.id).toBe(repeated.result.thread.id);
    expect(repeated.id).toBe(2);
    expect(owner.calls().filter((call: { method?: string }) => call.method === "thread/start")).toHaveLength(1);
    const attachment = await fetch(baseA + "/api/attachments?name=notes.txt", {
      method: "POST",
      headers,
      body: "persistent attachment",
    });
    expect(attachment.status).toBe(201);
    const file = (await attachment.json()).attachment;
    expect(JSON.stringify(file)).toContain("notes.txt");
    const projectResponse = await fetch(baseA + "/api/projects", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Persistent project", code: "persistent", revision: 0 }),
    });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json();
    const messagesA: unknown[] = [],
      messagesB: unknown[] = [];
    for (const [base, messages, protocol] of [
      [baseA, messagesA, "panda-engine-v1"],
      [baseB, messagesB, undefined],
    ] as const) {
      const socket = new WebSocket(base.replace("http", "ws") + "/ws", protocol, { headers });
      sockets.push(socket);
      socket.on("message", (value) => messages.push(JSON.parse(String(value))));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
    }
    owner.requestApproval({
      id: "native-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "old-alpha",
        turnId: "turn",
        command: "echo test",
        availableDecisions: ["accept", "decline"],
      },
    });
    const approval = await waitFor(() =>
      messagesA.find((message) => isRecord(message) && message.type === "engine/request"),
    );
    if (!isRecord(approval) || !isRecord(approval.payload)) throw new Error("Missing approval event");
    await waitFor(() => messagesB.some((message) => isRecord(message) && message.type === "codex/request"));
    const answer = { id: 5, requestId: approval.payload.id, result: { choiceId: "primary" } };
    const invalidAnswer = await fetch(baseA + "/api/engine/respond", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ...answer, result: { choiceId: "forged" } }),
    });
    expect(invalidAnswer.status).toBe(400);
    for (const base of [baseA, baseB]) {
      const response = await fetch(base + "/api/engine/respond", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(base === baseB ? { ...answer, result: { decision: "accept" } } : answer),
      });
      expect(response.status).toBe(200);
    }
    await waitFor(() =>
      owner!
        .calls()
        .some((call: { type?: string; id?: string }) => call.type === "response" && call.id === "native-approval"),
    );
    expect(
      owner
        .calls()
        .filter((call: { type?: string; id?: string }) => call.type === "response" && call.id === "native-approval"),
    ).toHaveLength(1);
    await audit.initialize();
    const oldLease = await audit.currentOwner(workspace);
    expect(oldLease).not.toBeNull();
    expect((await audit.readEvents(workspace, oldLease!.fence, 0)).length).toBeGreaterThan(0);
    async function readStream(base: string, cursor: string, marker: string) {
      const response = await fetch(base + "/api/events", {
        headers: { ...headers, "last-event-id": cursor },
        signal: AbortSignal.timeout(10_000),
      });
      const reader = response.body!.getReader();
      let text = "";
      try {
        for (let attempt = 0; attempt < 100 && !text.includes(marker); attempt++) {
          const value = await reader.read();
          if (value.done) break;
          text += new TextDecoder().decode(value.value);
        }
        expect(text).toContain(marker);
        return text;
      } finally {
        await reader.cancel();
      }
    }
    expect(await readStream(baseB, oldLease!.fence + ":0", "serverRequest/resolved")).toContain(
      "id: " + oldLease!.fence + ":",
    );
    const logout = await fetch(baseB + "/api/auth/logout", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    expect((await fetch(baseA + "/api/projects", { headers: { cookie } })).status).toBe(401);

    for (const socket of sockets) socket.close();
    await owner.stop();
    expect((await fetch(baseA + "/health/readiness")).status).toBe(503);
    await owner.start();
    const after = await fetch(baseB + "/api/projects", { headers }).then((response) => response.json());
    expect(after.projects[0].id).toBe(project.projects[0].id);
    expect((await audit.currentOwner(workspace))!.fence).toBe(oldLease!.fence + 1);
    expect((await fetch(baseB + "/api/projects", { headers: { cookie } })).status).toBe(401);
    await readStream(baseA, oldLease!.fence + ":0", "bridge/resync");

    const afterFile = await fetch(baseB + "/api/files/download?path=" + encodeURIComponent(file.path), { headers });
    expect(afterFile.status).toBe(200);
    expect(await afterFile.text()).toBe("persistent attachment");
  } finally {
    for (const socket of sockets) socket.terminate();
    await first?.close();
    await second?.close();
    await owner?.dispose();
    await audit.close();
    await database.dispose();
  }
}, 120_000);
