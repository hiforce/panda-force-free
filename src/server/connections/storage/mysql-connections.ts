import type { ConnectionInput, PublicationConnection } from "../../../shared/connections/contracts.js";
import type { MySQLSession } from "../../database/mysql-session.js";
import { ConnectionError } from "../errors.js";
import { publicationTargetHash } from "./target-hash.js";
export interface OwnedConnection {
  ownerId: string;
  targetPath: string;
  connection: PublicationConnection;
}
/** Targets retain ownership when disabled, so another connection cannot silently take over a site. */
export class MySQLConnectionRepository {
  constructor(private db: MySQLSession) {}
  async get(id: string): Promise<OwnedConnection> {
    return await this.db.atomic(async () => {
      const row = await this.db.one<{
        ownerId: string;
        targetPath: string;
        record: string;
      }>("SELECT ownerId,targetPath,record FROM panda_force_publication_connections WHERE id=?", [id]);
      if (!row) throw new ConnectionError("notFound", 404);
      return { ownerId: row.ownerId, targetPath: row.targetPath, connection: JSON.parse(row.record) };
    });
  }
  async list(ownerId: string, projectId: string): Promise<PublicationConnection[]> {
    return await this.db.atomic(async () => {
      return (
        await this.db.all<{
          record: string;
        }>(
          "SELECT record FROM panda_force_publication_connections WHERE ownerId=? AND projectId=? ORDER BY rowSequence DESC LIMIT 100",
          [ownerId, projectId],
        )
      ).map((row) => JSON.parse(row.record));
    });
  }
  async existing(ownerId: string, input: ConnectionInput): Promise<PublicationConnection | null> {
    return await this.db.atomic(async () => {
      const row = await this.db.one<{
        ownerId: string;
        request: string;
        record: string;
      }>("SELECT ownerId,request,record FROM panda_force_publication_connections WHERE id=?", [input.id]);
      if (!row) return null;
      if (row.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
      if (row.request !== JSON.stringify(input)) throw new ConnectionError("conflict", 409);
      return JSON.parse(row.record);
    });
  }
  async create(ownerId: string, input: ConnectionInput, targetPath: string) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const existing = await this.existing(ownerId, input);
        if (existing) return existing;
        const targets = await this.db.all<{
          targetPath: string;
        }>("SELECT targetPath FROM panda_force_publication_connections", []);
        if (targets.length >= 1000 || (await this.list(ownerId, input.projectId)).length >= 100)
          throw new ConnectionError("limit", 507);
        if (
          targets.some(
            (row) =>
              row.targetPath === targetPath ||
              row.targetPath.startsWith(targetPath + "/") ||
              targetPath.startsWith(row.targetPath + "/"),
          )
        )
          throw new ConnectionError("targetInUse", 409);
        const now = Date.now(),
          connection: PublicationConnection = { ...input, version: 1, enabled: true, createdAt: now, updatedAt: now };
        await this.db.execute(
          "INSERT INTO panda_force_publication_connections(id,ownerId,projectId,targetPath,record,request,targetPathHash) VALUES(?,?,?,?,?,?,?)",
          [
            input.id,
            ownerId,
            input.projectId,
            targetPath,
            JSON.stringify(connection),
            JSON.stringify(input),
            publicationTargetHash(targetPath),
          ],
        );
        return connection;
      });
    });
  }
  async update(
    ownerId: string,
    id: string,
    version: number,
    changes: Pick<PublicationConnection, "name" | "enabled" | "publicUrl">,
  ) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const stored = await this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        if (stored.connection.version !== version) throw new ConnectionError("conflict", 409);
        const connection = { ...stored.connection, ...changes, version: version + 1, updatedAt: Date.now() };
        await this.db.execute("UPDATE panda_force_publication_connections SET record=? WHERE id=?", [
          JSON.stringify(connection),
          id,
        ]);
        return connection;
      });
    });
  }
  async changeCredential(
    ownerId: string,
    id: string,
    version: number,
    persist: () =>
      | {
          revision: number;
        }
      | Promise<
          Awaited<{
            revision: number;
          }>
        >,
  ) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const stored = await this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        if (stored.connection.version !== version) throw new ConnectionError("conflict", 409);
        const credential = await persist();
        const connection = {
          ...stored.connection,
          credentialRevision: credential.revision,
          version: version + 1,
          updatedAt: Date.now(),
        };
        await this.db.execute("UPDATE panda_force_publication_connections SET record=? WHERE id=?", [
          JSON.stringify(connection),
          id,
        ]);
        return connection;
      });
    });
  }
  async replaceHostKey(ownerId: string, id: string, version: number, hostKey: string) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const stored = await this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        const current = stored.connection;
        if (current.version !== version) throw new ConnectionError("conflict", 409);
        if (current.connector !== "sftp-site") throw new ConnectionError("unsupportedConnector");
        if (current.hostKey === hostKey) return current;
        const connection = { ...current, hostKey, trustPending: true, version: version + 1, updatedAt: Date.now() };
        await this.db.execute("UPDATE panda_force_publication_connections SET record=? WHERE id=?", [
          JSON.stringify(connection),
          id,
        ]);
        return connection;
      });
    });
  }
  async completeTest(ownerId: string, id: string, version: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const stored = await this.get(id);
        if (stored.ownerId !== ownerId) throw new ConnectionError("notFound", 404);
        if (stored.connection.version !== version) throw new ConnectionError("conflict", 409);
        if (!stored.connection.trustPending) return stored.connection;
        // Verification updates readiness only; the trusted configuration version stays unchanged.
        const connection = { ...stored.connection, trustPending: false };
        await this.db.execute("UPDATE panda_force_publication_connections SET record=? WHERE id=?", [
          JSON.stringify(connection),
          id,
        ]);
        return connection;
      });
    });
  }
}
