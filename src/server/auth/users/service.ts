import { createHash } from "node:crypto";
import {
  createPasswordSession,
  createStoredPassword,
  storedPasswordSessionSecret,
  verifyPasswordSession,
  verifyStoredPassword,
  isStoredPassword,
} from "../security.js";
import { validAdministratorPassword } from "../../../shared/password-policy.js";
import type { StoredPassword } from "../password-store.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import type { AuthState } from "../state.js";
import { memberFields, memberId, memberRole, memberView } from "./records.js";
import { AccountError, type LocalIdentity, type LocalUserRecord, type LocalUserRepository } from "./contracts.js";

export const localAdministratorIdentity = (auth: Pick<AuthState, "administrator">): LocalIdentity | null =>
  auth.administrator
    ? {
        id: "installation",
        revision: 1,
        username: auth.administrator.username,
        role: "admin",
        owner:
          auth.administrator.ownerId ??
          createHash("sha256")
            .update(JSON.stringify(["local", auth.administrator.username, auth.administrator.createdAt]))
            .digest("hex"),
      }
    : null;
const identity = (user: LocalUserRecord): LocalIdentity => ({
  id: user.id,
  revision: user.credentialRevision ?? user.revision,
  username: user.username,
  role: user.role,
  owner:
    user.ownerId ??
    createHash("sha256")
      .update(JSON.stringify(["local-user", user.id]))
      .digest("hex"),
});
const secret = (user: LocalUserRecord) =>
  `${user.id}:${user.credentialRevision ?? user.revision}:${user.password ? storedPasswordSessionSecret(user.password) : ""}`;

/** User lifecycle and session identity are independent of model-provider credentials. */
export class LocalAccounts {
  private readonly watchers = new Map<string, { revision: number; callbacks: Set<() => void> }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | null = null;
  private closed = false;
  constructor(
    private readonly repository: LocalUserRepository,
    private readonly auth: Pick<AuthState, "administrator">,
  ) {}
  async administratorPassword() {
    const value = (await this.repository.settings()).administratorPassword;
    if (value && !isStoredPassword(value)) throw new AccountError("unavailable", 503);
    return value;
  }
  async passwordResetAvailable() {
    return Boolean((await this.repository.settings()).smtp);
  }
  async administratorLogin(username: string) {
    return (
      username === this.auth.administrator?.username ||
      username === (await this.repository.settings()).administratorEmail?.email
    );
  }
  async list() {
    const administrator = this.auth.administrator;
    return {
      users: [
        ...(administrator
          ? [
              {
                id: "installation",
                username: administrator.username,
                role: "admin",
                enabled: true,
                revision: 1,
                createdAt: administrator.createdAt,
                updatedAt: administrator.createdAt,
                installation: true,
              },
            ]
          : []),
        ...(await this.repository.list()).map((user) => ({ ...memberView(user), installation: false })),
      ],
    };
  }
  async update(id: unknown, input: unknown) {
    const p = memberFields(input, ["revision", "enabled", "role"]),
      previous = await this.repository.get(memberId(id));
    if (!previous) throw new AccountError("notFound", 404);
    if (!Number.isSafeInteger(p.revision) || p.revision !== previous.revision) throw new AccountError("conflict", 409);
    if (p.enabled !== undefined && typeof p.enabled !== "boolean") throw new AccountError("invalidInput");
    const next: LocalUserRecord = {
      ...previous,
      role: p.role === undefined ? previous.role : memberRole(p.role),
      enabled: p.enabled === undefined ? previous.enabled : (p.enabled as boolean),
      revision: previous.revision + 1,
      credentialRevision: (previous.credentialRevision ?? previous.revision) + 1,
      updatedAt: Date.now(),
    };
    await this.repository.update(next, previous.revision);
    this.notify(next.id);
    return memberView(next);
  }
  async login(username: string, supplied: string) {
    const user = await this.repository.find(username);
    if (!user || !user.enabled || !user.password || !verifyStoredPassword(supplied, user.password)) return null;
    const current = await this.repository.get(user.id);
    if (
      !current?.enabled ||
      (current.credentialRevision ?? current.revision) !== (user.credentialRevision ?? user.revision)
    )
      return null;
    const [expires, nonce, signature] = createPasswordSession(secret(user)).token.split(".");
    return { identity: identity(user), token: `${expires}.${nonce}.u1~${user.id}~${signature}` };
  }
  async changePassword(id: string, input: unknown) {
    const fields = memberFields(input, ["currentPassword", "password"]),
      user = await this.repository.get(memberId(id));
    if (
      !user?.enabled ||
      !user.password ||
      typeof fields.currentPassword !== "string" ||
      !verifyStoredPassword(fields.currentPassword, user.password)
    )
      throw new AccountError("incorrectPassword", 403);
    if (typeof fields.password !== "string" || !validAdministratorPassword(fields.password))
      throw new AccountError("passwordPolicy");
    await this.repository.update(
      {
        ...user,
        password: createStoredPassword(fields.password) as StoredPassword,
        revision: user.revision + 1,
        credentialRevision: (user.credentialRevision ?? user.revision) + 1,
        updatedAt: Date.now(),
      },
      user.revision,
    );
    this.notify(id);
    return { ok: true };
  }
  async authenticate(token: string | null) {
    if (!token) return null;
    const parts = token.split("."),
      pieces = parts[2]?.split("~");
    if (parts.length !== 3 || pieces?.length !== 3 || pieces[0] !== "u1" || !/^[a-f0-9-]{36}$/.test(pieces[1]))
      return null;
    const user = await this.repository.get(pieces[1]);
    return user?.enabled && user.password && verifyPasswordSession(`${parts[0]}.${parts[1]}.${pieces[2]}`, secret(user))
      ? identity(user)
      : null;
  }
  private notify(id: string) {
    const callbacks = [...(this.watchers.get(id)?.callbacks ?? [])];
    this.watchers.delete(id);
    for (const callback of callbacks)
      try {
        callback();
      } catch (error) {
        reportDiagnostic("accounts.connection-close", error);
      }
    if (!this.watchers.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  async watch(principal: LocalIdentity, close: () => void) {
    const current = await this.repository.get(principal.id);
    if (this.closed || !current?.enabled || (current.credentialRevision ?? current.revision) !== principal.revision) {
      close();
      return () => {};
    }
    let entry = this.watchers.get(principal.id);
    if (entry && entry.revision !== principal.revision) {
      this.notify(principal.id);
      entry = undefined;
    }
    if (!entry) this.watchers.set(principal.id, (entry = { revision: principal.revision, callbacks: new Set() }));
    entry.callbacks.add(close);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.poll().catch((error) => {
          reportDiagnostic("accounts.session-refresh", error);
          for (const id of this.watchers.keys()) this.notify(id);
        });
      }, 1000);
      this.timer.unref();
    }
    return () => {
      entry!.callbacks.delete(close);
      if (!entry!.callbacks.size && this.watchers.get(principal.id) === entry) this.watchers.delete(principal.id);
      if (!this.watchers.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }
  async poll() {
    if (this.polling) return this.polling;
    if (this.closed || !this.watchers.size) return;
    const work = (async () => {
      const users = new Map((await this.repository.list()).map((user) => [user.id, user]));
      if (this.closed) return;
      for (const [id, entry] of this.watchers) {
        const user = users.get(id);
        if (!user?.enabled || (user.credentialRevision ?? user.revision) !== entry.revision) this.notify(id);
      }
    })();
    this.polling = work;
    try {
      await work;
    } finally {
      if (this.polling === work) this.polling = null;
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const id of this.watchers.keys()) this.notify(id);
    this.watchers.clear();
    await this.polling;
    await this.repository.close();
  }
}
