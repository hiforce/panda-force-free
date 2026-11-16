import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { validAdministratorPassword } from "../../../shared/password-policy.js";
import type { CredentialEncryption } from "../../connections/credentials/ports.js";
import type { StoredPassword } from "../password-store.js";
import { createStoredPassword } from "../security.js";
import { AccountError, type LocalUserRecord, type LocalUserRepository } from "./contracts.js";
import { memberEmail, memberFields, memberId, memberRole, memberView } from "./records.js";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const binding = (id: string) => ({ connectionId: id, connectorId: "panda-invitation", ownerId: "installation" });
const lifetime = 24 * 60 * 60 * 1000;
const leaseDuration = 60_000;
const maximumAttempts = 6;

export interface InvitationMail {
  /** The transport must enforce a deadline shorter than the lease and must not log message bodies. */
  send(
    message: {
      id: string;
      to: string;
      link: string;
      expiresAt: number;
      purpose?: "invite" | "bind" | "reset";
      locale?: string;
      code?: string;
    },
    signal: AbortSignal,
  ): Promise<void>;
}

/** Atomic invitations use the member CAS revision; administrators never supply member passwords. */
export class MemberInvitations {
  private readonly publicUrl: URL;
  constructor(
    private readonly repository: LocalUserRepository,
    private readonly cipher: CredentialEncryption,
    private readonly mail: InvitationMail,
    publicUrl: string,
    private readonly now = Date.now,
  ) {
    this.publicUrl = new URL(publicUrl);
    if (
      (this.publicUrl.protocol !== "https:" &&
        !(
          this.publicUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.publicUrl.hostname)
        )) ||
      this.publicUrl.username ||
      this.publicUrl.password ||
      this.publicUrl.search ||
      this.publicUrl.hash
    )
      throw new AccountError("invalidInput");
  }

  private async pending(
    id: string,
    operationId: string,
    options: { verificationCode?: boolean } = {},
  ): Promise<NonNullable<LocalUserRecord["invitation"]>> {
    const token = `${id}.${randomBytes(32).toString("base64url")}`;
    const code = options.verificationCode ? String(randomInt(0, 1_000_000)).padStart(6, "0") : undefined;
    const envelope = await this.cipher.seal(binding(id), { token, ...(code ? { code } : {}) });
    return {
      operationId,
      digest: digest(token),
      expiresAt: this.now() + (code ? 600_000 : lifetime),
      ...(code ? { requestedAt: this.now(), code: { envelope, attempts: 0 } } : {}),
      delivery: {
        state: "pending",
        envelope,
        attempts: 0,
        nextAttemptAt: this.now(),
      },
    };
  }

  async invite(input: unknown) {
    const fields = memberFields(input, ["email", "role", "operationId"]);
    const email = memberEmail(fields.email);
    const role = memberRole(fields.role ?? "member");
    const operationId = memberId(fields.operationId);
    const existing = await this.repository.find(email);
    if (existing) {
      if (!existing.password && existing.invitation?.operationId === operationId && existing.role === role)
        return memberView(existing);
      throw new AccountError("conflict", 409);
    }
    const id = randomUUID(),
      now = this.now();
    const user: LocalUserRecord = {
      id,
      username: email,
      role,
      enabled: true,
      password: null,
      credentialRevision: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      invitation: await this.pending(id, operationId),
    };
    try {
      await this.repository.create(user);
    } catch (error) {
      if (!(error instanceof AccountError) || error.code !== "conflict") throw error;
      // A concurrent retry can observe the winner without issuing a second token or delivery.
      const winner = await this.repository.find(email);
      if (!winner || winner.invitation?.operationId !== operationId || winner.role !== role) throw error;
      return memberView(winner);
    }
    return memberView(user);
  }

  async resend(id: string, revision: number, operationId: string) {
    const current = await this.repository.get(memberId(id));
    if (!current || !current.enabled || current.password || !current.invitation)
      throw new AccountError("notFound", 404);
    memberId(operationId);
    if (current.invitation.operationId === operationId) return memberView(current);
    if (current.revision !== revision) throw new AccountError("conflict", 409);
    const next = {
      ...current,
      invitation: {
        ...(await this.pending(id, operationId)),
        purpose: current.invitation.purpose,
        locale: current.invitation.locale,
      },
      revision: revision + 1,
      updatedAt: this.now(),
    };
    await this.repository.update(next, revision);
    return memberView(next);
  }
  /** Dedicated challenge repositories use this without inserting a login account. */
  async challenge(
    email: string,
    operationId: string,
    purpose: "bind" | "reset",
    locale: string,
    options: { verificationCode?: boolean } = {},
  ) {
    const id = randomUUID(),
      now = this.now();
    memberId(operationId);
    const record: LocalUserRecord = {
      id,
      username: memberEmail(email),
      role: "admin",
      enabled: true,
      password: null,
      revision: 1,
      credentialRevision: 1,
      createdAt: now,
      updatedAt: now,
      ...(options.verificationCode ? { recoveryRequest: { at: now, id: operationId } } : {}),
      invitation: { ...(await this.pending(id, operationId, options)), purpose, locale },
    };
    await this.repository.create(record);
    return memberView(record);
  }

  async reset(
    user: LocalUserRecord,
    operationId: string,
    locale: string,
    options: { verificationCode?: boolean } = {},
  ) {
    memberId(operationId);
    const invitation = { ...(await this.pending(user.id, operationId, options)), purpose: "reset" as const, locale };
    await this.repository.update(
      {
        ...user,
        invitation,
        ...(options.verificationCode ? { recoveryRequest: { at: this.now(), id: operationId } } : {}),
        credentialRevision: user.credentialRevision ?? user.revision,
        revision: user.revision + 1,
        updatedAt: this.now(),
      },
      user.revision,
    );
    return { ok: true };
  }
  /** One code yields one short-lived password capability. Retries of the same verification reuse that result. */
  async verifyCode(input: unknown) {
    const fields = memberFields(input, ["challengeId", "code", "verificationId"]);
    const id = memberId(fields.challengeId),
      verificationId = memberId(fields.verificationId);
    if (typeof fields.code !== "string" || !/^[0-9]{6}$/.test(fields.code)) throw new AccountError("invalidCode");
    for (let attempt = 0; attempt < 4; attempt++) {
      const user = await this.repository.findChallenge(id),
        invitation = user?.invitation,
        challenge = invitation?.code;
      if (
        !user?.enabled ||
        invitation?.purpose !== "reset" ||
        !challenge ||
        invitation.expiresAt <= this.now() ||
        challenge.attempts >= 5 ||
        (challenge.verifiedAt && challenge.verificationId !== verificationId)
      )
        throw new AccountError("invalidCode");
      const secret = await this.cipher.open(binding(user.id), challenge.envelope);
      if (
        typeof secret.code !== "string" ||
        !/^[0-9]{6}$/.test(secret.code) ||
        typeof secret.token !== "string" ||
        digest(secret.token) !== invitation.digest
      )
        throw new AccountError("unavailable", 503);
      const correct = timingSafeEqual(Buffer.from(fields.code), Buffer.from(secret.code));
      if (correct && challenge.verifiedAt)
        return { token: secret.token, email: user.username, expiresAt: invitation.expiresAt };
      const now = this.now();
      try {
        await this.repository.update(
          {
            ...user,
            credentialRevision: user.credentialRevision ?? user.revision,
            revision: user.revision + 1,
            updatedAt: now,
            invitation: {
              ...invitation,
              expiresAt: correct ? Math.min(invitation.expiresAt, now + 300_000) : invitation.expiresAt,
              code: {
                ...challenge,
                attempts: challenge.attempts + (correct ? 0 : 1),
                ...(correct ? { verifiedAt: now, verificationId } : {}),
              },
              ...(correct
                ? {
                    delivery: {
                      state: "sent",
                      envelope: null,
                      attempts: invitation.delivery.attempts,
                      nextAttemptAt: 0,
                    },
                  }
                : {}),
            },
          },
          user.revision,
        );
      } catch (error) {
        if (error instanceof AccountError && error.code === "conflict" && attempt < 3) continue;
        throw error;
      }
      if (!correct) throw new AccountError("invalidCode");
      return { token: secret.token, email: user.username, expiresAt: Math.min(invitation.expiresAt, now + 300_000) };
    }
    throw new AccountError("invalidCode");
  }
  private async tokenMember(token: unknown) {
    if (typeof token !== "string" || !/^[a-f0-9-]{36}\.[a-zA-Z0-9_-]{43}$/.test(token))
      throw new AccountError("invalidInvitation", 400);
    const user = await this.repository.get(memberId(token.slice(0, 36)));
    if (
      !user?.enabled ||
      (user.password && user.invitation?.purpose !== "reset") ||
      !user.invitation ||
      user.invitation.expiresAt <= this.now() ||
      (user.invitation.code && !user.invitation.code.verifiedAt) ||
      user.invitation.digest !== digest(token)
    )
      throw new AccountError("invalidInvitation", 400);
    return user;
  }

  async inspect(token: unknown) {
    const user = await this.tokenMember(token);
    return { email: user.username, expiresAt: user.invitation!.expiresAt };
  }

  async accept(input: unknown) {
    const fields = memberFields(input, ["token", "password"]);
    const user = await this.tokenMember(fields.token);
    if (typeof fields.password !== "string" || !validAdministratorPassword(fields.password))
      throw new AccountError("passwordPolicy");
    const { invitation, ...record } = user;
    void invitation;
    const next: LocalUserRecord = {
      ...record,
      credentialRevision: (user.credentialRevision ?? user.revision) + 1,
      password: createStoredPassword(fields.password) as StoredPassword,
      revision: user.revision + 1,
      updatedAt: this.now(),
    };
    await this.repository.update(next, user.revision);
    return { ok: true };
  }

  /** Delivery is at least once with the same token. SMTP acceptance is distinct from inbox delivery. */
  async deliver(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = await this.repository.get(memberId(id)),
      invitation = current?.invitation,
      now = this.now();
    if (
      !current?.enabled ||
      (current.password && invitation?.purpose !== "reset") ||
      !invitation ||
      invitation.expiresAt <= now ||
      invitation.code?.verifiedAt ||
      !invitation.delivery.envelope ||
      invitation.delivery.state === "sent" ||
      invitation.delivery.state === "failed" ||
      invitation.delivery.nextAttemptAt > now ||
      (invitation.delivery.leaseUntil ?? 0) > now
    )
      return false;
    const leaseId = randomUUID();
    const claimed: LocalUserRecord = {
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      invitation: {
        ...invitation,
        delivery: {
          ...invitation.delivery,
          state: "sending",
          attempts: invitation.delivery.attempts + 1,
          leaseId,
          leaseUntil: now + leaseDuration,
        },
      },
    };
    try {
      await this.repository.update(claimed, current.revision);
    } catch (error) {
      if (error instanceof AccountError && error.code === "conflict") return false;
      throw error;
    }
    let sent = false;
    try {
      const secret = await this.cipher.open(binding(id), invitation.delivery.envelope);
      if (typeof secret.token !== "string" || digest(secret.token) !== invitation.digest)
        throw new AccountError("unavailable", 503);
      if (invitation.code && (typeof secret.code !== "string" || !/^[0-9]{6}$/.test(secret.code)))
        throw new AccountError("unavailable", 503);
      const link = new URL(
        invitation.purpose === "bind"
          ? "/verify-email"
          : invitation.purpose === "reset"
            ? "/reset-password"
            : "/invite",
        this.publicUrl,
      );
      link.hash = `token=${encodeURIComponent(secret.token)}`;
      await this.mail.send(
        {
          id: `panda-invite-${id}-${invitation.digest.slice(0, 16)}`,
          to: current.username,
          link: link.href,
          expiresAt: invitation.expiresAt,
          purpose: invitation.purpose,
          locale: invitation.locale,
          ...(invitation.code && typeof secret.code === "string" ? { code: secret.code } : {}),
        },
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      );
      sent = true;
    } catch {
      // The administration view exposes a stable failure state, never SMTP replies, credentials or tokens.
    }
    const latest = await this.repository.get(id);
    if (
      !latest?.invitation ||
      latest.invitation.digest !== invitation.digest ||
      latest.invitation.delivery.leaseId !== leaseId
    )
      return sent;
    const delivery = latest.invitation.delivery;
    const next: LocalUserRecord = {
      ...latest,
      revision: latest.revision + 1,
      updatedAt: this.now(),
      invitation: {
        ...latest.invitation,
        delivery: {
          state: sent ? "sent" : delivery.attempts >= maximumAttempts ? "failed" : "pending",
          envelope: sent ? null : delivery.envelope,
          attempts: delivery.attempts,
          nextAttemptAt: sent
            ? 0
            : this.now() +
              Math.max(invitation.code ? 60_000 : 0, Math.min(900_000, 5_000 * 2 ** (delivery.attempts - 1))),
        },
      },
    };
    try {
      await this.repository.update(next, latest.revision);
    } catch (error) {
      if (!(error instanceof AccountError) || error.code !== "conflict") throw error;
    }
    return sent;
  }
}
