import type { SQL } from "bun";
import { MySQLSocialAccountRepository } from "../../connections/accounts/mysql-repository.js";
import { MySQLCredentialRepository } from "../../connections/credentials/mysql-repository.js";
import { MySQLOAuthAttempts } from "../../connections/oauth/mysql-attempts.js";
import type { ConnectionPersistence } from "../../connections/persistence.js";
import { MySQLConnectionRepository } from "../../connections/storage/mysql-connections.js";
import { MySQLSession } from "../../database/mysql-session.js";
import { MySQLPublicationRepository } from "../mysql-repository.js";
import { MySQLWorkflowRepository } from "../storage/mysql-workflows.js";
export interface PublicationPersistence {
  connections: ConnectionPersistence;
  site: MySQLPublicationRepository;
  workflow(kind: string): MySQLWorkflowRepository;
}
/** One reserved unit-of-work preserves atomic credential/account/consent and publication metadata callbacks. The caller owns schema and pool lifecycle. */
export function createMySQLPublicationPersistence(
  sql: SQL,
  now = Date.now,
  options: { transactionConnection?: <T>(work: (sql: SQL) => Promise<T>) => Promise<T> } = {},
): PublicationPersistence {
  const session = new MySQLSession(sql, {
    mutexTable: "panda_force_publication_mutex",
    transactionConnection: options.transactionConnection,
    numericColumns: [
      "version",
      "revision",
      "credentialRevision",
      "updatedAt",
      "createdAt",
      "expiresAt",
      "leaseFence",
      "leaseUntil",
      "refreshDispatched",
      "checkOnly",
      "nextRunAt",
      "acknowledgedAt",
      "fence",
      "attempt",
      "completedAt",
      "retryAllowed",
      "replacedBy",
      "observedAt",
      "requestedAt",
      "decidedAt",
      "stepId",
      "bytes",
      "count",
      "n",
      "total",
      "rowSequence",
      "rowid",
      "ordinal",
      "chunkCount",
    ],
  });
  return {
    connections: {
      records: new MySQLConnectionRepository(session),
      secrets: new MySQLCredentialRepository(session, now),
      accounts: new MySQLSocialAccountRepository(session),
      attempts: new MySQLOAuthAttempts(session, now),
      transaction: (work) => session.atomic(async () => await work()),
    },
    site: new MySQLPublicationRepository(session, now),
    workflow: (kind) => new MySQLWorkflowRepository(session, kind, now),
  };
}
