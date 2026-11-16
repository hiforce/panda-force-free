import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAppFixture } from "../support/app-fixture.mjs";
test("the authenticated skill catalog persists builtin installation across actual application restart", async () => {
  const app = await createAppFixture();
  const cookies = new Map<string, string>();
  const read = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(app.base + path, {
      headers: { cookie: [...cookies.values()].join("; "), ...headers },
    });
    return { status: response.status, body: await response.json() };
  };
  const authenticate = async (path: string, body: unknown) => {
    const response = await fetch(app.base + path, {
      method: "POST",
      headers: { cookie: [...cookies.values()].join("; "), "content-type": "application/json", Origin: app.base },
      body: JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return response;
  };
  try {
    expect((await fetch(app.base + "/api/skills")).status).toBe(401);
    expect((await fetch(app.base + "/api/skill-packs")).status).toBe(401);
    // Service credentials alone do not establish an administrator-owned catalog.
    expect((await fetch(app.base + "/api/skills", { headers: app.headers })).status).toBe(403);
    const login = await authenticate("/api/auth/login", {
      username: "fixture-owner",
      password: "visibility-test",
    });
    expect(login.status).toBe(200);
    expect((await login.json()).migrationRequired).toBe(true);
    expect((await authenticate("/api/auth/setup", { username: "fixture-owner" })).status).toBe(200);
    expect((await authenticate("/api/system/database/selection", { driver: "sqlite" })).status).toBe(200);
    const first = await read("/api/skills");
    expect(first.status).toBe(200);
    expect(first.body.skills.length).toBe(20);
    const collection = first.body.skills.filter(
      (skill: { packageId: string }) => skill.packageId === "panda-force.essentials",
    );
    expect(collection).toHaveLength(18);
    expect(collection.every((skill: { role: string }) => skill.role === "template")).toBe(true);
    const original = first.body.skills.find(
      (skill: { packageId: string }) => skill.packageId === "panda-force.writing",
    );
    expect(original).toMatchObject({
      packageId: "panda-force.writing",
      version: "1.0.0",
      id: "writing",
      category: "writing",
      role: "workflow",
      origin: { kind: "builtin", id: "panda-force.writing" },
    });
    expect(original.name).toEqual({ en: "Writing", "zh-CN": "写作" });
    expect(original.digest).toMatch(/^[a-f0-9]{64}$/);
    const packages = await read("/api/skill-packs");
    expect(packages.body.revision).toBe(3);
    expect(packages.body.packages.length).toBe(3);
    expect(packages.body.packages[0].installedBy).toBe("system:builtin-skills");
    const invalid = await read("/api/skills?limit=0", { "accept-language": "zh-CN" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.messageId).toBe("skills.invalidInput");
    // API errors retain English fallback copy; clients localize the stable message ID.
    expect(invalid.body.error).toBe("The skill library request is invalid.");
    expect(
      (
        await fetch(app.base + "/api/skills", {
          method: "POST",
          headers: { cookie: [...cookies.values()].join("; "), Origin: app.base },
          body: "{}",
        })
      ).status,
    ).toBe(405);
    expect(existsSync(join(app.dir, "skills"))).toBe(false);
    expect(existsSync(join(app.dir, "panda-state", "data", "skills.sqlite"))).toBe(true);
    await app.stop();
    await app.start();
    expect((await read("/api/skills")).body).toEqual(first.body);
    expect((await read("/api/skill-packs")).body).toEqual(packages.body);
    expect(existsSync(join(app.dir, "skills"))).toBe(false);
  } finally {
    await app.dispose();
  }
}, 30000);
