import type { AccountAuthorizationPhase } from "../../../shared/connections/accounts.js";
import { randomUUID, createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
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
export class OAuthAttempts {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS publication_oauth_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)",
    );
    db.transaction(() => {
      const version =
        db.query<{ version: number }, []>("SELECT version FROM publication_oauth_schema WHERE id=1").get()?.version ||
        0;
      if (version > 1) throw new OAuthError("authorizationUnavailable");
      if (!version)
        db.exec(`CREATE TABLE publication_oauth_attempts (
        id TEXT PRIMARY KEY,stateHash TEXT UNIQUE,ownerId TEXT NOT NULL,connectionId TEXT NOT NULL,record TEXT NOT NULL,
        phase TEXT NOT NULL,secret TEXT,expiresAt INTEGER NOT NULL
      ); CREATE INDEX publication_oauth_owner ON publication_oauth_attempts(ownerId);
      INSERT INTO publication_oauth_schema VALUES(1,1);`);
    }).immediate();
  }
  encryptedCount() {
    return this.db
      .query<{ total: number }, []>("SELECT count(*) AS total FROM publication_oauth_attempts WHERE secret IS NOT NULL")
      .get()!.total;
  }
  reserve(target: OAuthAttemptTarget): OAuthAttempt {
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
    return this.db
      .transaction(() => {
        this.db.query("DELETE FROM publication_oauth_attempts WHERE expiresAt<=?").run(this.now());
        const all = this.db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM publication_oauth_attempts")
          .get()!.count;
        const owner = this.db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM publication_oauth_attempts WHERE ownerId=?",
          )
          .get(attempt.ownerId)!.count;
        if (all >= 1000 || owner >= 10) throw new OAuthError("authorizationRateLimited");
        // Reserve order is durable before asynchronous encryption; a slower older request cannot supersede it.
        this.db
          .query(
            "UPDATE publication_oauth_attempts SET phase='failed',secret=NULL WHERE ownerId=? AND connectionId=? AND phase IN ('preparing','prepared','exchanging','verifying')",
          )
          .run(attempt.ownerId, attempt.connectionId);
        this.db
          .query("INSERT INTO publication_oauth_attempts VALUES(?,?,?,?,?,?,?,?)")
          .run(
            attempt.id,
            null,
            attempt.ownerId,
            attempt.connectionId,
            JSON.stringify(attempt),
            "preparing",
            null,
            attempt.expiresAt,
          );
        return attempt;
      })
      .immediate();
  }
  prepare(
    owner: string,
    id: string,
    state: string,
    verifier: SecretEnvelope,
    validate: (attempt: OAuthAttempt) => void,
  ) {
    const stateHash = oauthStateHash(state);
    return this.db
      .transaction(() => {
        const { attempt } = this.owned(owner, id);
        if (attempt.phase !== "preparing") throw new OAuthError("authorizationConsumed");
        validate(attempt);
        this.db
          .query("UPDATE publication_oauth_attempts SET phase='prepared',stateHash=?,secret=? WHERE id=?")
          .run(stateHash, JSON.stringify(verifier), id);
        return this.status(owner, id);
      })
      .immediate();
  }
  private owned(owner: string, id: string) {
    const row = this.db
      .query<StoredAttempt, [string, string]>(
        "SELECT record,phase,secret,expiresAt FROM publication_oauth_attempts WHERE id=? AND ownerId=?",
      )
      .get(id, owner);
    if (!row || row.expiresAt <= this.now()) throw new OAuthError("authorizationExpired");
    const attempt = { ...JSON.parse(row.record), phase: row.phase } as OAuthAttempt;
    return { attempt, secret: row.secret ? (JSON.parse(row.secret) as SecretEnvelope) : null };
  }
  status(owner: string, id: string) {
    return this.owned(owner, id).attempt;
  }
  lookup(owner: string, state: string) {
    const row = this.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM publication_oauth_attempts WHERE stateHash=? AND ownerId=?",
      )
      .get(oauthStateHash(state), owner);
    if (!row) throw new OAuthError("authorizationExpired");
    return this.status(owner, row.id);
  }
  claim(owner: string, state: string, validate: (attempt: OAuthAttempt) => void) {
    return this.db
      .transaction(() => {
        const { attempt, secret } = this.owned(owner, this.lookup(owner, state).id);
        if (attempt.phase !== "prepared" || !secret) throw new OAuthError("authorizationConsumed");
        validate(attempt);
        this.db
          .query("UPDATE publication_oauth_attempts SET phase='exchanging',secret=NULL WHERE id=?")
          .run(attempt.id);
        return { attempt: { ...attempt, phase: "exchanging" as const }, secret };
      })
      .immediate();
  }
  stage(owner: string, id: string, tokens: SecretEnvelope, validate: (attempt: OAuthAttempt) => void) {
    return this.db
      .transaction(() => {
        const { attempt } = this.owned(owner, id);
        if (attempt.phase !== "exchanging") throw new OAuthError("authorizationConsumed");
        validate(attempt);
        this.db
          .query("UPDATE publication_oauth_attempts SET phase='verifying',secret=? WHERE id=?")
          .run(JSON.stringify(tokens), id);
        return this.status(owner, id);
      })
      .immediate();
  }
  pending(owner: string, id: string) {
    const value = this.owned(owner, id);
    if (value.attempt.phase !== "verifying" || !value.secret) throw new OAuthError("authorizationConsumed");
    return { attempt: value.attempt, secret: value.secret };
  }
  /** The synchronous accept callback commits the account and re-bound ciphertext in this database transaction. */
  complete(owner: string, id: string, accept: (attempt: OAuthAttempt) => { id: string; version: number }) {
    return this.db
      .transaction(() => {
        const { attempt } = this.pending(owner, id);
        const value = accept(attempt);
        if (!value || value.id !== attempt.connectionId || !Number.isSafeInteger(value.version) || value.version < 1)
          throw new OAuthError("authorizationUnavailable");
        this.db.query("UPDATE publication_oauth_attempts SET phase='complete',secret=NULL WHERE id=?").run(id);
        return value;
      })
      .immediate();
  }
  abandon(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const { attempt } = this.owned(owner, id);
        if (attempt.phase === "complete") throw new OAuthError("authorizationConsumed");
        this.db.query("UPDATE publication_oauth_attempts SET phase='failed',secret=NULL WHERE id=?").run(id);
      })
      .immediate();
  }
}
