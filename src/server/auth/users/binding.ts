import {
  AccountError,
  type LocalAccountSettings,
  type LocalUserRecord,
  type LocalUserRepository,
} from "./contracts.js";
import { MemberInvitations } from "./invitations.js";
import type { LocalAccountMail } from "./mail.js";
import { memberEmail, memberFields, memberView } from "./records.js";

/** Reuse the invitation outbox for one installation-administrator email challenge, without creating a login user. */
export function administratorBindingRepository(repository: LocalUserRepository): LocalUserRepository {
  const replace = async (record: LocalUserRecord, expected: number | null) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const settings = await repository.settings(),
        current = settings.binding;
      if (expected !== null && (!current || current.id !== record.id || current.revision !== expected))
        throw new AccountError("conflict", 409);
      try {
        await repository.saveSettings(
          { ...settings, revision: settings.revision + 1, binding: record },
          settings.revision,
        );
        return;
      } catch (error) {
        if (!(error instanceof AccountError) || error.code !== "conflict" || attempt === 2) throw error;
      }
    }
  };
  return {
    list: async () => {
      const binding = (await repository.settings()).binding;
      return binding ? [binding] : [];
    },
    get: async (id) => {
      const binding = (await repository.settings()).binding;
      return binding?.id === id ? binding : null;
    },
    find: async (email) => {
      const binding = (await repository.settings()).binding;
      return binding?.username === email ? binding : null;
    },
    findChallenge: async (id) => {
      const row = (await repository.settings()).binding;
      return row?.invitation?.operationId === id ? row : null;
    },
    create: async (record) => replace(record, null),
    update: async (record, revision) => replace(record, revision),
    settings: () => repository.settings(),
    saveSettings: (record, revision) => repository.saveSettings(record, revision),
    close: () => {},
  };
}

export class AdministratorEmailBinding {
  readonly repository: LocalUserRepository;
  constructor(
    private readonly installation: LocalUserRepository,
    private readonly mail: LocalAccountMail,
  ) {
    this.repository = administratorBindingRepository(installation);
  }
  async view() {
    const settings = await this.installation.settings();
    return {
      email: settings.administratorEmail?.email ?? null,
      verifiedAt: settings.administratorEmail?.verifiedAt ?? null,
      pending: settings.binding ? memberView(settings.binding) : null,
    };
  }
  private async invitations() {
    const smtp = await this.mail.require();
    return new MemberInvitations(this.repository, this.mail.cipher, this.mail, smtp.publicUrl);
  }
  async issue(input: unknown, locale: string) {
    await this.mail.require();
    await this.mail.initialize();
    const fields = memberFields(input, ["email", "operationId"]),
      email = memberEmail(fields.email),
      settings = await this.installation.settings();
    if (await this.installation.find(email)) throw new AccountError("conflict", 409);
    if (settings.administratorEmail?.email === email) return this.view();
    const invitations = await this.invitations(),
      current = settings.binding;
    const result =
      current?.username === email
        ? await invitations.resend(current.id, current.revision, String(fields.operationId))
        : await invitations.challenge(email, String(fields.operationId), "bind", locale);
    const pending = await this.repository.get(result.id);
    if (pending?.invitation && pending.invitation.purpose !== "bind")
      await this.repository.update(
        { ...pending, invitation: { ...pending.invitation, purpose: "bind", locale }, revision: pending.revision + 1 },
        pending.revision,
      );
    return this.view();
  }
  async confirm(input: unknown) {
    const fields = memberFields(input, ["token"]),
      settings = await this.installation.settings(),
      pending = settings.binding;
    if (!pending?.invitation || pending.invitation.purpose !== "bind") throw new AccountError("invalidInvitation");
    const snapshot = { ...settings, binding: structuredClone(pending) };
    const repository: LocalUserRepository = {
      ...this.repository,
      get: async (id) => (id === pending.id ? pending : null),
    };
    const invitations = new MemberInvitations(repository, this.mail.cipher, this.mail, "https://localhost");
    await invitations.inspect(fields.token);
    const { binding, administratorReset, ...rest } = snapshot;
    void binding;
    void administratorReset;
    const next: LocalAccountSettings = {
      ...rest,
      revision: settings.revision + 1,
      administratorEmail: { email: pending.username, verifiedAt: Date.now() },
    };
    await this.installation.saveSettings(next, settings.revision);
    return { ok: true };
  }
  async deliver(signal: AbortSignal) {
    const pending = (await this.installation.settings()).binding;
    if (pending) await (await this.invitations()).deliver(pending.id, signal);
  }
}
