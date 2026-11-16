import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseManagementState, type StoredDatabaseOperation } from "../../src/server/database/management/state.js";
import { startDatabaseMaintenance } from "../../src/server/database/maintenance.js";

test("the real maintenance shell gates business readiness and wires host capability recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-maintenance-http-")),
    state = new DatabaseManagementState(root),
    id = randomUUID(),
    token = "T".repeat(43),
    replacement = "R".repeat(43),
    now = Date.now();
  let server: Awaited<ReturnType<typeof startDatabaseMaintenance>> | undefined;
  try {
    const record: StoredDatabaseOperation = {
      schema: 1,
      owner: "a".repeat(64),
      planId: randomUUID(),
      statusTokenHash: createHash("sha256").update(token).digest("hex"),
      tokenExpiresAt: now + 60000,
      public: {
        id,
        status: "failed",
        stage: "failed",
        source: { driver: "sqlite" },
        target: { driver: "mysql", hostname: "private-target.example", database: "private_db" },
        modules: [],
        startedAt: now,
        updatedAt: now,
        canRetry: true,
        canCancel: false,
      },
    };
    await state.write("operations", id, record);
    await state.write("", "pending", { operationId: id });
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    let wake = 0;
    server = await startDatabaseMaintenance({
      state,
      operationId: id,
      host: "127.0.0.1",
      port,
      publicDir: new URL("../../public", import.meta.url).pathname,
      wake: () => {
        wake++;
      },
    });
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(base + "/health/startup")).status).toBe(200);
    expect((await fetch(base + "/health/readiness")).status).toBe(503);
    expect((await fetch(base + "/api/projects")).status).toBe(503);
    const status = await (await fetch(base + "/api/system/database/maintenance")).text();
    expect(JSON.parse(status)).toEqual({ operationId: id, status: "failed" });
    expect(status).not.toContain("private-target");
    const html = await (await fetch(base + "/settings/storage")).text();
    expect(html).toContain("database-maintenance.bundle.js?v=");
    expect(html).not.toContain("/app.bundle.js");
    expect(html).not.toContain("auth-bootstrap");
    const marker = await state.read<{ operationId: string; secret: string }>("", "host-recovery");
    expect(marker?.operationId).toBe(id);
    const post = async (path: string, body: unknown, headers: Record<string, string>) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post(
          "/api/system/database/host-recovery",
          { statusToken: replacement },
          { origin: "https://wrong.example", "x-panda-database-host-recovery": marker!.secret },
        )
      ).status,
    ).toBe(403);
    const recovered = await post(
      "/api/system/database/host-recovery",
      { statusToken: replacement },
      { origin: base, "x-panda-database-host-recovery": marker!.secret },
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ operationId: id, recovered: true });
    expect(
      (
        await fetch(base + "/api/system/database/operations/" + id, {
          headers: { "x-panda-database-operation": token },
        })
      ).status,
    ).toBe(401);
    const progress = await fetch(base + "/api/system/database/operations/" + id, {
      headers: { "x-panda-database-operation": replacement },
    });
    expect(progress.status).toBe(200);
    expect((await progress.json()).status).toBe("failed");
    const retry = await post(
      "/api/system/database/operations/" + id + "/retry",
      {},
      { origin: base, "x-panda-database-operation": replacement },
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe("waiting-restart");
    await Bun.sleep(100);
    expect(wake).toBe(1);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
