import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { localAuthFixture } from "../support/local-auth-fixture.mjs";
import { smtpFixture } from "../support/smtp-fixture.js";

const cookie = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];
const token = (html: string) =>
  new URLSearchParams(new URL(html.match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&")).hash.slice(1)).get("token")!;
const verificationCode = (html: string) => html.match(/data-verification-code>([0-9]{6})</)![1];
async function waitMessage(mail: Awaited<ReturnType<typeof smtpFixture>>, count: number) {
  for (let i = 0; i < 100; i++) {
    if (mail.messages.length >= count) return mail.messages[count - 1];
    await Bun.sleep(100);
  }
  throw Error("Expected local SMTP delivery");
}

test("local email invitation, role boundaries, optional root binding and password recovery survive restart", async () => {
  const mail = await smtpFixture(),
    f = await localAuthFixture();
  const password = "Original-password-123",
    next = "Changed-password-123";
  try {
    const created = await f.post("/api/auth/setup", { username: "rocky", password });
    expect(created.status).toBe(200);
    let root = cookie(created);
    expect((await fetch(f.base + "/api/system/database/maintenance")).status).toBe(401);
    const initial = await fetch(f.base + "/api/local-users/self", { headers: { cookie: root } });
    expect(await initial.json()).toMatchObject({ username: "rocky", email: null, smtpConfigured: false });
    expect(
      (
        await f.post(
          "/api/local-users/email",
          { email: "root@example.com", operationId: randomUUID() },
          { cookie: root },
        )
      ).status,
    ).toBe(409);
    const saved = await fetch(f.base + "/api/local-users/mail", {
      method: "PUT",
      headers: { origin: f.base, cookie: root, "content-type": "application/json" },
      body: JSON.stringify({ ...mail.config, revision: 0, publicUrl: f.base }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain(mail.config.password);
    expect(
      (
        await f.post(
          "/api/local-users/email",
          { email: "root@example.com", operationId: randomUUID() },
          { cookie: root },
        )
      ).status,
    ).toBe(202);
    const binding = token((await waitMessage(mail, 1)).html);
    expect(
      (await fetch(f.base + "/api/local-users/self", { headers: { cookie: root } }).then((r) => r.json())).email,
    ).toBeNull();
    expect((await f.post("/api/local-users/email/confirm", { token: binding })).status).toBe(200);
    const alias = await f.post("/api/auth/login", { username: "root@example.com", password });
    expect(alias.status).toBe(200);
    const invited = await f.post(
      "/api/local-users",
      { email: "member@example.com", role: "member", operationId: randomUUID() },
      { cookie: root },
    );
    expect(invited.status).toBe(202);
    const memberId = (await invited.json()).user.id;
    const invitation = token((await waitMessage(mail, 2)).html);
    expect((await f.post("/api/local-users/invitation/accept", { token: invitation, password })).status).toBe(200);
    const memberLogin = await f.post("/api/auth/login", { username: "member@example.com", password });
    expect(memberLogin.status).toBe(200);
    let member = cookie(memberLogin);
    for (const path of [
      "/api/local-users",
      "/api/local-users/mail",
      "/api/files/download?path=/etc/passwd",
      "/api/approvals",
      "/api/events",
      "/api/system/database/maintenance",
    ])
      expect((await fetch(f.base + path, { headers: { cookie: member } })).status).toBe(403);
    expect((await f.post("/api/rpc", { method: "thread/list" }, { cookie: member })).status).toBe(403);
    const config = await fetch(f.base + "/api/config", { headers: { cookie: member } }).then((r) => r.json());
    expect(config.sharedWorkspace).toBe(false);
    expect(config.home).toBeUndefined();
    expect((await fetch(f.base + "/api/content-access", { headers: { cookie: member } })).status).toBe(200);
    const memberChallenge = await (
      await f.post("/api/local-users/reset/request", { identifier: "member@example.com" })
    ).json();
    const memberCode = verificationCode((await waitMessage(mail, 3)).html);
    const memberProof = await f.post("/api/local-users/reset/verify", {
      challengeId: memberChallenge.challengeId,
      code: memberCode,
      verificationId: randomUUID(),
    });
    expect(memberProof.status).toBe(200);
    const memberReset = (await memberProof.json()).token;
    expect((await fetch(f.base + "/api/config", { headers: { cookie: member } })).status).toBe(200);
    expect((await f.post("/api/local-users/reset/accept", { token: memberReset, password: next })).status).toBe(200);
    expect((await fetch(f.base + "/api/config", { headers: { cookie: member } })).status).toBe(401);
    expect((await f.post("/api/auth/login", { username: "member@example.com", password })).status).toBe(401);
    member = cookie(await f.post("/api/auth/login", { username: "member@example.com", password: next }));
    const users = await fetch(f.base + "/api/local-users", { headers: { cookie: root } }).then((r) => r.json());
    const row = users.users.find((u: { id: string }) => u.id === memberId);
    expect(
      (
        await f.post(
          "/api/local-users/update",
          { id: row.id, revision: row.revision, enabled: false },
          { cookie: root },
        )
      ).status,
    ).toBe(200);
    expect((await fetch(f.base + "/api/config", { headers: { cookie: member } })).status).toBe(401);
    await f.restart();
    root = cookie(await f.post("/api/auth/login", { username: "rocky", password }));
    expect((await f.post("/api/local-users/reset/request", { identifier: "unknown@example.com" })).status).toBe(200);
    const rootChallenge = await (await f.post("/api/local-users/reset/request", { identifier: "rocky" })).json();
    const rootCode = verificationCode((await waitMessage(mail, 4)).html);
    await f.restart();
    const retry = await (await f.post("/api/local-users/reset/request", { identifier: "root@example.com" })).json();
    expect(retry.challengeId).toBe(rootChallenge.challengeId);
    expect(retry.retryAfter).toBeGreaterThan(0);
    expect(mail.messages.length).toBe(4);
    const rootProof = await f.post("/api/local-users/reset/verify", {
      challengeId: rootChallenge.challengeId,
      code: rootCode,
      verificationId: randomUUID(),
    });
    expect(rootProof.status).toBe(200);
    const reset = (await rootProof.json()).token;
    expect((await f.post("/api/local-users/reset/accept", { token: reset, password: next })).status).toBe(200);
    expect((await f.post("/api/local-users/reset/accept", { token: reset, password: next })).status).toBe(400);
    expect((await fetch(f.base + "/api/config", { headers: { cookie: root } })).status).toBe(401);
    expect((await f.post("/api/auth/login", { username: "rocky", password })).status).toBe(401);
    expect((await f.post("/api/auth/login", { username: "root@example.com", password: next })).status).toBe(200);
    await f.restart();
    expect((await f.post("/api/auth/login", { username: "rocky", password: next })).status).toBe(200);
  } finally {
    await f.dispose();
    await mail.close();
  }
}, 60000);
