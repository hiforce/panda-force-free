import { createHash, randomUUID } from "node:crypto";
import type { AccountAuthorizationPhase } from "../../../shared/connections/accounts.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import type { SecretEnvelope } from "../credentials/ports.js";
import { OAuthError } from "./errors.js";
export interface OAuthAttemptTarget {
  ownerId: string;
  projectId: string;
  connectionId: string;
  connectionVersion: number;
  providerId: string;
  configuration: string;
}
export type OAuthAttemptPhase = AccountAuthorizationPhase;
export interface OAuthAttempt extends OAuthAttemptTarget {
  id: string;
  createdAt: number;
  expiresAt: number;
  phase: OAuthAttemptPhase;
}
interface StoredAttempt {
  record: string;
  phase: OAuthAttemptPhase;
  secret: string | null;
  expiresAt: number;
}
export function oauthStateHash(state: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new OAuthError("invalidOAuthInput");
  return createHash("sha256").update(state).digest("hex");
}
/** Consumes callback state before token exchange. A crashed exchange can only be replaced by fresh consent. */
export class MySQLOAuthAttempts {
  constructor(
    private db: MySQLSession,
    private now = Date.now,
  ) {}
  async encryptedCount() {
    return await this.db.atomic(async () => {
      return (await this.db.one<{
        total: number;
      }>("SELECT count(*) AS total FROM panda_force_publication_oauth_attempts WHERE secret IS NOT NULL", []))!.total;
    });
  }
  async reserve(target: OAuthAttemptTarget): Promise<OAuthAttempt> {
    return await this.db.atomic(async () => {
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
      if (
        !uuid.test(target.projectId) ||
        !uuid.test(target.connectionId) ||
        typeof target.ownerId !== "string" ||
        !target.ownerId ||
        target.ownerId.length > 256 ||
        /[\p{Cc}\p{Cs}]/u.test(target.ownerId) ||
        !/^[a-z][a-z0-9.-]{0,63}$/.test(target.providerId) ||
        !/^[a-f0-9]{64}$/.test(target.configuration) ||
        !Number.isSafeInteger(target.connectionVersion) ||
        target.connectionVersion < 1
      )
        throw new OAuthError("invalidOAuthInput");
      const now = this.now();
      const attempt: OAuthAttempt = {
        ownerId: target.ownerId,
        projectId: target.projectId,
        connectionId: target.connectionId,
        connectionVersion: target.connectionVersion,
        providerId: target.providerId,
        configuration: target.configuration,
        id: randomUUID(),
        createdAt: now,
        expiresAt: now + 600000,
        phase: "preparing",
      };
      return await this.db.atomic(async () => {
        await this.db.execute("DELETE FROM panda_force_publication_oauth_attempts WHERE expiresAt<=?", [this.now()]);
        const all = (await this.db.one<{
          count: number;
        }>("SELECT count(*) AS count FROM panda_force_publication_oauth_attempts", []))!.count;
        const owner = (await this.db.one<{
          count: number;
        }>("SELECT count(*) AS count FROM panda_force_publication_oauth_attempts WHERE ownerId=?", [attempt.ownerId]))!
          .count;
        if (all >= 1000 || owner >= 10) throw new OAuthError("authorizationRateLimited");
        // Reserve order is durable before asynchronous encryption; a slower older request cannot supersede it.
        await this.db.execute(
          "UPDATE panda_force_publication_oauth_attempts SET phase='failed',secret=NULL WHERE ownerId=? AND connectionId=? AND phase IN ('preparing','prepared','exchanging','verifying')",
          [attempt.ownerId, attempt.connectionId],
        );
        await this.db.execute(
          "INSERT INTO panda_force_publication_oauth_attempts(id,stateHash,ownerId,connectionId,record,phase,secret,expiresAt) VALUES(?,?,?,?,?,?,?,?)",
          [
            attempt.id,
            null,
            attempt.ownerId,
            attempt.connectionId,
            JSON.stringify(attempt),
            "preparing",
            null,
            attempt.expiresAt,
          ],
        );
        return attempt;
      });
    });
  }
  async prepare(
    owner: string,
    id: string,
    state: string,
    verifier: SecretEnvelope,
    validate: (attempt: OAuthAttempt) => void | Promise<Awaited<void>>,
  ) {
    return await this.db.atomic(async () => {
      const stateHash = oauthStateHash(state);
      return await this.db.atomic(async () => {
        const { attempt } = await this.owned(owner, id);
        if (attempt.phase !== "preparing") throw new OAuthError("authorizationConsumed");
        await validate(attempt);
        await this.db.execute(
          "UPDATE panda_force_publication_oauth_attempts SET phase='prepared',stateHash=?,secret=? WHERE id=?",
          [stateHash, JSON.stringify(verifier), id],
        );
        return await this.status(owner, id);
      });
    });
  }
  private async owned(owner: string, id: string) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<StoredAttempt>(
        "SELECT record,phase,secret,expiresAt FROM panda_force_publication_oauth_attempts WHERE id=? AND ownerId=?",
        [id, owner],
      );
      if (!row || row.expiresAt <= this.now()) throw new OAuthError("authorizationExpired");
      const attempt = { ...JSON.parse(row.record), phase: row.phase } as OAuthAttempt;
      return { attempt, secret: row.secret ? (JSON.parse(row.secret) as SecretEnvelope) : null };
    });
  }
  async status(owner: string, id: string) {
    return await this.db.atomic(async () => {
      return (await this.owned(owner, id)).attempt;
    });
  }
  async lookup(owner: string, state: string) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<{
        id: string;
      }>("SELECT id FROM panda_force_publication_oauth_attempts WHERE stateHash=? AND ownerId=?", [
        oauthStateHash(state),
        owner,
      ]);
      if (!row) throw new OAuthError("authorizationExpired");
      return await this.status(owner, row.id);
    });
  }
  async claim(owner: string, state: string, validate: (attempt: OAuthAttempt) => void | Promise<Awaited<void>>) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const { attempt, secret } = await this.owned(owner, (await this.lookup(owner, state)).id);
        if (attempt.phase !== "prepared" || !secret) throw new OAuthError("authorizationConsumed");
        await validate(attempt);
        await this.db.execute(
          "UPDATE panda_force_publication_oauth_attempts SET phase='exchanging',secret=NULL WHERE id=?",
          [attempt.id],
        );
        return { attempt: { ...attempt, phase: "exchanging" as const }, secret };
      });
    });
  }
  async stage(
    owner: string,
    id: string,
    tokens: SecretEnvelope,
    validate: (attempt: OAuthAttempt) => void | Promise<Awaited<void>>,
  ) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const { attempt } = await this.owned(owner, id);
        if (attempt.phase !== "exchanging") throw new OAuthError("authorizationConsumed");
        await validate(attempt);
        await this.db.execute(
          "UPDATE panda_force_publication_oauth_attempts SET phase='verifying',secret=? WHERE id=?",
          [JSON.stringify(tokens), id],
        );
        return await this.status(owner, id);
      });
    });
  }
  async pending(owner: string, id: string) {
    return await this.db.atomic(async () => {
      const value = await this.owned(owner, id);
      if (value.attempt.phase !== "verifying" || !value.secret) throw new OAuthError("authorizationConsumed");
      return { attempt: value.attempt, secret: value.secret };
    });
  }
  /** The awaited accept callback commits the account and re-bound ciphertext in this native transaction. */
  async complete(
    owner: string,
    id: string,
    accept: (attempt: OAuthAttempt) =>
      | {
          id: string;
          version: number;
        }
      | Promise<
          Awaited<{
            id: string;
            version: number;
          }>
        >,
  ) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const { attempt } = await this.pending(owner, id);
        const value = await accept(attempt);
        if (!value || value.id !== attempt.connectionId || !Number.isSafeInteger(value.version) || value.version < 1)
          throw new OAuthError("authorizationUnavailable");
        await this.db.execute(
          "UPDATE panda_force_publication_oauth_attempts SET phase='complete',secret=NULL WHERE id=?",
          [id],
        );
        return value;
      });
    });
  }
  async abandon(owner: string, id: string) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const { attempt } = await this.owned(owner, id);
        if (attempt.phase === "complete") throw new OAuthError("authorizationConsumed");
        await this.db.execute(
          "UPDATE panda_force_publication_oauth_attempts SET phase='failed',secret=NULL WHERE id=?",
          [id],
        );
      });
    });
  }
}
