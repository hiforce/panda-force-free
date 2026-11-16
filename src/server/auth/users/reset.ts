import { randomUUID } from "node:crypto";
import { AccountError, type LocalUserRecord, type LocalUserRepository } from "./contracts.js";
import type { AuthState } from "../state.js";
import { MemberInvitations } from "./invitations.js";
import type { LocalAccountMail } from "./mail.js";
import { memberEmail, memberFields } from "./records.js";

/** The root recovery challenge commits its new credential and consumes its token in one settings CAS. */
function rootResetRepository(repository: LocalUserRepository): LocalUserRepository {
  const replace = async (record: LocalUserRecord, revision: number | null) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const settings = await repository.settings(),
        current = settings.administratorReset;
      if (revision !== null && (!current || current.id !== record.id || current.revision !== revision))
        throw new AccountError("conflict", 409);
      if (
        revision === null &&
        record.invitation?.code &&
        (settings.recoveryRequest?.at ?? current?.invitation?.requestedAt ?? 0) > Date.now() - 60_000
      )
        throw new AccountError("conflict", 409);
      const { administratorReset, ...rest } = settings;
      void administratorReset;
      const next = record.password
        ? {
            ...rest,
            revision: settings.revision + 1,
            administratorPassword: record.password,
            administratorEmail: { email: record.username, verifiedAt: Date.now() },
          }
        : {
            ...settings,
            revision: settings.revision + 1,
            administratorReset: record,
            ...(record.recoveryRequest ? { recoveryRequest: record.recoveryRequest } : {}),
          };
      try {
        await repository.saveSettings(next, settings.revision);
        return;
      } catch (error) {
        if (!(error instanceof AccountError) || error.code !== "conflict" || attempt === 2) throw error;
      }
    }
  };
  return {
    list: async () => {
      const row = (await repository.settings()).administratorReset;
      return row ? [row] : [];
    },
    get: async (id) => {
      const row = (await repository.settings()).administratorReset;
      return row?.id === id ? row : null;
    },
    find: async (email) => {
      const row = (await repository.settings()).administratorReset;
      return row?.username === email ? row : null;
    },
    findChallenge: async (id) => {
      const row = (await repository.settings()).administratorReset;
      return row?.invitation?.operationId === id ? row : null;
    },
    create: async (record) => replace(record, null),
    update: (record, revision) => replace(record, revision),
    settings: () => repository.settings(),
    saveSettings: (record, revision) => repository.saveSettings(record, revision),
    close: () => {},
  };
}

export class LocalPasswordRecovery {
  readonly rootRepository: LocalUserRepository;
  private readonly requests = new Map<string, { at: number; id: string }>();
  constructor(
    private readonly repository: LocalUserRepository,
    private readonly mail: LocalAccountMail,
    private readonly auth: Pick<AuthState, "administrator">,
  ) {
    this.rootRepository = rootResetRepository(repository);
  }
  private async invitations(repository: LocalUserRepository) {
    const config = await this.mail.require();
    return new MemberInvitations(repository, this.mail.cipher, this.mail, config.publicUrl);
  }
  async request(input: unknown, locale: string) {
    const fields = memberFields(input, ["identifier"]);
    if (typeof fields.identifier !== "string" || fields.identifier.length > 254) throw new AccountError("invalidInput");
    const identifier = fields.identifier.trim().toLowerCase(),
      now = Date.now();
    const reply = (id: string, at: number) => ({
      ok: true,
      challengeId: id,
      retryAfter: Math.max(0, Math.ceil((at + 60_000 - Date.now()) / 1000)),
    });
    const unknown = () => {
      const previous = this.requests.get(identifier);
      if (previous && previous.at > now - 60_000) return reply(previous.id, previous.at);
      for (const [key, item] of this.requests) if (item.at < now - 600_000) this.requests.delete(key);
      if (this.requests.size >= 1024) throw new AccountError("tooManyAttempts", 429);
      const item = { at: now, id: randomUUID() };
      this.requests.set(identifier, item);
      return reply(item.id, item.at);
    };
    const settings = await this.repository.settings();
    if (!settings.smtp) return unknown();
    await this.mail.initialize();
    const root = this.auth.administrator ? settings.administratorEmail?.email : undefined;
    let repository: LocalUserRepository, user: LocalUserRecord | null;
    if (root && (identifier === root || identifier === this.auth.administrator?.username)) {
      repository = this.rootRepository;
      user = settings.administratorReset ?? null;
    } else {
      let email: string;
      try {
        email = memberEmail(identifier);
      } catch {
        return unknown();
      }
      repository = this.repository;
      user = await repository.find(email);
      if (!user?.enabled || !user.password) return unknown();
    }
    const recent = (record: LocalUserRecord | null, rootRequest?: { at: number; id: string }) => {
      const last =
        rootRequest ??
        record?.recoveryRequest ??
        (record?.invitation?.code
          ? { at: record.invitation.requestedAt ?? 0, id: record.invitation.operationId }
          : undefined);
      return last && last.at > Date.now() - 60_000 ? last : null;
    };
    const existing = recent(user, repository === this.rootRepository ? settings.recoveryRequest : undefined);
    if (existing) return reply(existing.id, existing.at);
    const service = await this.invitations(repository),
      id = randomUUID();
    try {
      if (repository === this.rootRepository)
        await service.challenge(root!, id, "reset", locale, { verificationCode: true });
      else await service.reset(user!, id, locale, { verificationCode: true });
    } catch (error) {
      if (!(error instanceof AccountError) || error.code !== "conflict") throw error;
      const settings = await repository.settings();
      const winner = recent(
        repository === this.rootRepository ? (settings.administratorReset ?? null) : await repository.get(user!.id),
        repository === this.rootRepository ? settings.recoveryRequest : undefined,
      );
      if (!winner) throw error;
      return reply(winner.id, winner.at);
    }
    return reply(id, now);
  }
  async verify(input: unknown) {
    const fields = memberFields(input, ["challengeId", "code", "verificationId"]);
    const root =
      typeof fields.challengeId === "string" ? await this.rootRepository.findChallenge(fields.challengeId) : null;
    return new MemberInvitations(
      root ? this.rootRepository : this.repository,
      this.mail.cipher,
      this.mail,
      "https://localhost",
    ).verifyCode(fields);
  }
  private async service(token: unknown) {
    if (typeof token !== "string") throw new AccountError("invalidInvitation");
    const id = token.slice(0, 36),
      root = await this.rootRepository.get(id),
      member = root ?? (await this.repository.get(id));
    if (member?.invitation?.purpose !== "reset") throw new AccountError("invalidInvitation");
    return new MemberInvitations(
      root ? this.rootRepository : this.repository,
      this.mail.cipher,
      this.mail,
      "https://localhost",
    );
  }
  async inspect(token: unknown) {
    return (await this.service(token)).inspect(token);
  }
  async accept(input: unknown) {
    const fields = memberFields(input, ["token", "password"]);
    return (await this.service(fields.token)).accept(fields);
  }
  async deliver(signal: AbortSignal) {
    const pending = (await this.repository.settings()).administratorReset;
    if (pending) await (await this.invitations(this.rootRepository)).deliver(pending.id, signal);
  }
}
