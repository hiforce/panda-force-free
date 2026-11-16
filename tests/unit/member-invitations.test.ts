import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SQLiteLocalUsers } from "../../src/server/auth/users/sqlite.js";
import { MemberInvitations, type InvitationMail } from "../../src/server/auth/users/invitations.js";
import { LocalAccounts } from "../../src/server/auth/users/service.js";
import { CredentialCipher } from "../../src/server/connections/credentials/cipher.js";
import { LocalAccountMail } from "../../src/server/auth/users/mail.js";
import { LocalPasswordRecovery } from "../../src/server/auth/users/reset.js";
import { createStoredAdministrator } from "../../src/server/auth/administrator-store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture(mail?: InvitationMail) {
  const path = mkdtempSync(join(tmpdir(), "panda-members-"));
  const repository = new SQLiteLocalUsers(join(path, "users.sqlite"));
  const accounts = new LocalAccounts(repository, { administrator: null });
  const messages: Parameters<InvitationMail["send"]>[0][] = [];
  let now = Date.now();
  const cipher = new CredentialCipher({ load: async () => ({ id: "test-key", bytes: Buffer.alloc(32, 9) }) });
  const invitations = new MemberInvitations(
    repository,
    cipher,
    mail ?? {
      send: async (message) => {
        messages.push(message);
      },
    },
    "https://panda.example",
    () => now,
  );
  cleanups.push(async () => {
    await accounts.close();
    rmSync(path, { recursive: true, force: true });
  });
  return {
    path,
    cipher,
    repository,
    accounts,
    invitations,
    messages,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
const token = (link: string) => new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
const password = "Member-secret-123";

describe("member invitations", () => {
  test("unknown, pending, disabled and missing-root accounts never queue recovery email", async () => {
    const f = fixture(),
      auth = { administrator: createStoredAdministrator("rocky", "Original-password-123") };
    let sends = 0;
    const mail = new LocalAccountMail(f.repository, join(f.path, "mail.key"), async (_config, _signal, message) => {
      if (message) sends++;
    });
    await mail.save(
      {
        revision: 0,
        host: "smtp.example.com",
        port: 465,
        security: "tls",
        username: "",
        from: "panda@example.com",
        publicUrl: "https://panda.example",
      },
      new AbortController().signal,
    );
    const settings = f.repository.settings();
    f.repository.saveSettings(
      {
        ...settings,
        revision: settings.revision + 1,
        administratorEmail: { email: "root@example.com", verifiedAt: Date.now() },
      },
      settings.revision,
    );
    const pending = await f.invitations.invite({ email: "pending@example.com", operationId: randomUUID() });
    const disabled = await f.invitations.invite({ email: "disabled@example.com", operationId: randomUUID() });
    await f.invitations.deliver(disabled.id, new AbortController().signal);
    await f.invitations.accept({ token: token(f.messages[0].link), password });
    await f.accounts.update(disabled.id, { revision: f.repository.get(disabled.id)!.revision, enabled: false });
    const before = f.repository.list();
    const recovery = new LocalPasswordRecovery(f.repository, mail, auth);
    for (const identifier of ["unknown@example.com", "pending@example.com", "disabled@example.com", "not-a-user"]) {
      const result = await recovery.request({ identifier }, "en");
      expect(result.ok).toBe(true);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
      expect(result.challengeId).toMatch(/^[a-f0-9-]{36}$/);
    }
    const orphan = new LocalPasswordRecovery(f.repository, mail, { administrator: null });
    await orphan.request({ identifier: "root@example.com" }, "en");
    await recovery.deliver(new AbortController().signal);
    expect(f.repository.settings().administratorReset).toBeUndefined();
    expect(f.repository.list()).toEqual(before);
    expect(f.repository.get(pending.id)!.password).toBeNull();
    expect(sends).toBe(0);
  });
  test("six-digit codes precede reset grants, survive service recreation and consume once", async () => {
    const f = fixture();
    const member = await f.invitations.invite({ email: "member@example.com", operationId: randomUUID() });
    await f.invitations.deliver(member.id, new AbortController().signal);
    await f.invitations.accept({ token: token(f.messages[0].link), password });
    const session = (await f.accounts.login("member@example.com", password))!;
    const challengeId = randomUUID();
    await f.invitations.reset(f.repository.get(member.id)!, challengeId, "en", { verificationCode: true });
    await f.invitations.deliver(member.id, new AbortController().signal);
    const message = f.messages[1],
      raw = token(message.link);
    expect(message.code).toMatch(/^[0-9]{6}$/);
    expect(JSON.stringify(await f.accounts.list())).not.toContain(message.code!);
    await expect(f.invitations.accept({ token: raw, password: "Changed-password-123" })).rejects.toMatchObject({
      code: "invalidInvitation",
    });
    const reopened = new SQLiteLocalUsers(join(f.path, "users.sqlite"));
    const verify = new MemberInvitations(reopened, f.cipher, { send: async () => {} }, "https://panda.example");
    try {
      const wrong = message.code === "000000" ? "111111" : "000000";
      await expect(verify.verifyCode({ challengeId, code: wrong, verificationId: randomUUID() })).rejects.toMatchObject(
        { code: "invalidCode" },
      );
      expect((await f.accounts.authenticate(session.token))?.id).toBe(member.id);
      const input = { challengeId, code: message.code, verificationId: randomUUID() };
      const proof = await verify.verifyCode(input);
      expect(proof.token).toBe(raw);
      expect(await verify.verifyCode(input)).toEqual(proof);
      await expect(verify.verifyCode({ ...input, verificationId: randomUUID() })).rejects.toMatchObject({
        code: "invalidCode",
      });
      expect((await f.accounts.authenticate(session.token))?.id).toBe(member.id);
      await verify.accept({ token: proof.token, password: "Changed-password-123" });
      expect(await f.accounts.authenticate(session.token)).toBeNull();
      await expect(verify.accept({ token: proof.token, password })).rejects.toMatchObject({
        code: "invalidInvitation",
      });
    } finally {
      reopened.close();
    }
  });
  test("code failures are counted atomically, expire and are replaced by a resend", async () => {
    const f = fixture();
    const member = await f.invitations.invite({ email: "member@example.com", operationId: randomUUID() });
    await f.invitations.deliver(member.id, new AbortController().signal);
    await f.invitations.accept({ token: token(f.messages[0].link), password });
    const challengeId = randomUUID();
    await f.invitations.reset(f.repository.get(member.id)!, challengeId, "en", { verificationCode: true });
    await f.invitations.deliver(member.id, new AbortController().signal);
    const code = f.messages[1].code!,
      wrong = code === "000000" ? "111111" : "000000";
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        f.invitations.verifyCode({ challengeId, code: wrong, verificationId: randomUUID() }),
      ),
    );
    expect(outcomes.every((x) => x.status === "rejected")).toBe(true);
    expect(f.repository.get(member.id)!.invitation!.code!.attempts).toBeGreaterThanOrEqual(4);
    await expect(
      f.invitations.verifyCode({ challengeId, code: wrong, verificationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "invalidCode" });
    await expect(f.invitations.verifyCode({ challengeId, code, verificationId: randomUUID() })).rejects.toMatchObject({
      code: "invalidCode",
    });
    const next = randomUUID();
    await f.invitations.reset(f.repository.get(member.id)!, next, "en", { verificationCode: true });
    await f.invitations.deliver(member.id, new AbortController().signal);
    await expect(f.invitations.verifyCode({ challengeId, code, verificationId: randomUUID() })).rejects.toMatchObject({
      code: "invalidCode",
    });
    f.advance(600_001);
    await expect(
      f.invitations.verifyCode({ challengeId: next, code: f.messages[2].code, verificationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "invalidCode" });
  });
  test("root aliases and simultaneous requests share one durable sixty-second cooldown", async () => {
    const f = fixture(),
      auth = { administrator: createStoredAdministrator("rocky", "Original-password-123") };
    let source = "";
    const mail = new LocalAccountMail(f.repository, join(f.path, "mail.key"), async (_config, _signal, message) => {
      if (message) source = message.source;
    });
    await mail.save(
      {
        revision: 0,
        host: "smtp.example.com",
        port: 465,
        security: "tls",
        username: "",
        from: "panda@example.com",
        publicUrl: "https://panda.example",
      },
      new AbortController().signal,
    );
    const settings = f.repository.settings();
    f.repository.saveSettings(
      {
        ...settings,
        revision: settings.revision + 1,
        administratorEmail: { email: "root@example.com", verifiedAt: Date.now() },
      },
      settings.revision,
    );
    const first = new LocalPasswordRecovery(f.repository, mail, auth),
      second = new LocalPasswordRecovery(f.repository, mail, auth);
    const replies = await Promise.all([
      first.request({ identifier: "rocky" }, "en"),
      second.request({ identifier: "root@example.com" }, "en"),
    ]);
    expect(replies[0].challengeId).toBe(replies[1].challengeId);
    expect(replies[0].retryAfter).toBeGreaterThan(0);
    const restarted = new LocalPasswordRecovery(f.repository, mail, auth);
    expect((await restarted.request({ identifier: "ROOT@example.com" }, "en")).challengeId).toBe(
      replies[0].challengeId,
    );
    await first.deliver(new AbortController().signal);
    const body = Buffer.from(source.split("\r\n\r\n")[1].replace(/\s/g, ""), "base64").toString("utf8");
    const proof = await first.verify({
      challengeId: replies[0].challengeId,
      code: body.match(/data-verification-code>([0-9]{6})</)![1],
      verificationId: randomUUID(),
    });
    await first.accept({ token: proof.token, password: "Replacement-password-123" });
    expect(f.repository.settings().administratorReset).toBeUndefined();
    expect((await restarted.request({ identifier: "rocky" }, "en")).challengeId).toBe(replies[0].challengeId);
    expect(f.repository.settings().administratorReset).toBeUndefined();
    const current = f.repository.settings();
    f.repository.saveSettings(
      {
        ...current,
        revision: current.revision + 1,
        recoveryRequest: { at: Date.now() - 61_000, id: replies[0].challengeId },
      },
      current.revision,
    );
    expect((await restarted.request({ identifier: "rocky" }, "en")).challengeId).not.toBe(replies[0].challengeId);
  });
  test("duplicate submissions persist one invitation; only its recipient can set the password once", async () => {
    const f = fixture(),
      input = { email: "Member@example.com", role: "member", operationId: randomUUID() };
    const [first, second] = await Promise.all([f.invitations.invite(input), f.invitations.invite(input)]);
    expect(first.id).toBe(second.id);
    expect(f.repository.list()).toHaveLength(1);
    expect(await f.accounts.login("member@example.com", password)).toBeNull();
    expect(JSON.stringify(first)).not.toMatch(/digest|envelope|token|password/);
    await f.invitations.deliver(first.id, new AbortController().signal);
    expect(f.messages).toHaveLength(1);
    const raw = f.repository.get(first.id)!;
    expect(raw.invitation!.delivery.envelope).toBeNull();
    const secret = token(f.messages[0].link);
    expect(new URL(f.messages[0].link).search).toBe("");
    expect(await f.invitations.inspect(secret)).toMatchObject({ email: "member@example.com" });
    const outcomes = await Promise.allSettled([
      f.invitations.accept({ token: secret, password }),
      f.invitations.accept({ token: secret, password }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await f.accounts.login("member@example.com", password))?.identity.role).toBe("member");
    await expect(f.invitations.inspect(secret)).rejects.toMatchObject({ code: "invalidInvitation" });
    const user = f.repository.get(first.id)!;
    await expect(
      f.accounts.update(user.id, { revision: user.revision, password: "Administrator-chosen-123" }),
    ).rejects.toMatchObject({ code: "invalidInput" });
  });

  test("resend expires the old token and an expired or disabled invitation cannot activate", async () => {
    const f = fixture(),
      member = await f.invitations.invite({ email: "member@example.com", operationId: randomUUID() });
    await f.invitations.deliver(member.id, new AbortController().signal);
    const old = token(f.messages[0].link),
      current = f.repository.get(member.id)!;
    const renewed = await f.invitations.resend(member.id, current.revision, randomUUID());
    await expect(f.invitations.inspect(old)).rejects.toMatchObject({ code: "invalidInvitation" });
    await f.invitations.deliver(renewed.id, new AbortController().signal);
    const next = token(f.messages[1].link);
    await f.accounts.update(member.id, { revision: f.repository.get(member.id)!.revision, enabled: false });
    await expect(f.invitations.accept({ token: next, password })).rejects.toMatchObject({ code: "invalidInvitation" });
    const second = await f.invitations.invite({ email: "other@example.com", operationId: randomUUID() });
    await f.invitations.deliver(second.id, new AbortController().signal);
    f.advance(24 * 60 * 60 * 1000 + 1);
    await expect(f.invitations.accept({ token: token(f.messages[2].link), password })).rejects.toMatchObject({
      code: "invalidInvitation",
    });
  });

  test("SMTP failures retain encrypted delivery for retry without exposing secrets", async () => {
    let attempts = 0,
      link = "";
    const f = fixture({
      send: async (message) => {
        attempts++;
        link = message.link;
        if (attempts === 1) throw Error("sensitive SMTP server response");
      },
    });
    const member = await f.invitations.invite({ email: "member@example.com", operationId: randomUUID() });
    expect(await f.invitations.deliver(member.id, new AbortController().signal)).toBe(false);
    expect(f.repository.get(member.id)!.invitation!.delivery.state).toBe("pending");
    expect(JSON.stringify(await f.accounts.list())).not.toMatch(/token|ciphertext|SMTP/);
    expect(await f.invitations.deliver(member.id, new AbortController().signal)).toBe(false);
    expect(attempts).toBe(1);
    const firstLink = link;
    f.advance(5001);
    expect(await f.invitations.deliver(member.id, new AbortController().signal)).toBe(true);
    expect(link).toBe(firstLink);
    expect(attempts).toBe(2);
  });

  test("delivery claims exclude a concurrent worker and cannot undo a concurrent account disable", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture({
      send: async () => {
        entered();
        await pending;
      },
    });
    const member = await f.invitations.invite({ email: "member@example.com", operationId: randomUUID() });
    const work = f.invitations.deliver(member.id, new AbortController().signal);
    await sending;
    expect(await f.invitations.deliver(member.id, new AbortController().signal)).toBe(false);
    await f.accounts.update(member.id, { revision: f.repository.get(member.id)!.revision, enabled: false });
    release();
    await work;
    expect(f.repository.get(member.id)!.enabled).toBe(false);
  });

  test("role changes revoke managed sessions and watched connections across service instances", async () => {
    const f = fixture(),
      member = await f.invitations.invite({ email: "member@example.com", operationId: randomUUID() });
    await f.invitations.deliver(member.id, new AbortController().signal);
    await f.invitations.accept({ token: token(f.messages[0].link), password });
    const session = (await f.accounts.login("member@example.com", password))!;
    expect((await f.accounts.authenticate(session.token))?.id).toBe(member.id);
    let closed = 0;
    await f.accounts.watch(session.identity, () => {
      closed++;
    });
    const current = f.repository.get(member.id)!;
    f.repository.update(
      {
        ...current,
        role: "admin",
        revision: current.revision + 1,
        credentialRevision: (current.credentialRevision ?? current.revision) + 1,
      },
      current.revision,
    );
    expect(await f.accounts.authenticate(session.token)).toBeNull();
    await f.accounts.poll();
    expect(closed).toBe(1);
    expect((await f.accounts.login("member@example.com", password))!.identity.owner).toBe(session.identity.owner);
  });
});
