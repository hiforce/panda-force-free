import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { randomUUID } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import type { IndexReference } from "../ports.js";
import type { IndexResourceAllocation, IndexResourceTicket, PhysicalIndexResource } from "../resources/contracts.js";
import { mysqlResourceReferenced } from "./mysql-resource-references.js";
import { validResourceAllocation } from "../resources/validation.js";
import { IndexIntegrityError } from "../integrity.js";
import { mysqlReadReferenceBarrier } from "./mysql-reference-barrier.js";
const leaseMs = 120000;
export const resourceGraceMs = 300000;
const validName = (value: string) => /^[a-f0-9]{64}$/.test(value);
/** Durable ownership, observation and fenced claims are separate from upstream IO and maintenance scheduling. */
export class MySQLSearchIndexResources {
  constructor(
    private db: MySQLMetadataContext,
    private now = Date.now,
  ) {}
  async get(storage: string, name: string) {
    return await this.db.atomic(async () => {
      const row = await this.db.one<IndexResourceAllocation>(
        "SELECT * FROM panda_force_search_resources WHERE storage=? AND name=?",
        [storage, name],
      );
      if (row && !validResourceAllocation(row)) throw new IndexIntegrityError("unverified");
      return row;
    });
  }
  async page(storage: string, after = "") {
    return await this.db.atomic(async () => {
      return await this.db.all<{
        name: string;
      }>(
        "SELECT name FROM panda_force_search_resources WHERE storage=? AND name>? AND state!='deleted' ORDER BY name LIMIT 32",
        [storage, after],
      );
    });
  }
  async reserve(storage: string, name: string, recipe: string, marker: string) {
    return await this.db.atomic(async () => {
      if (!validName(storage) || !validName(name) || !recipe || recipe.length > 1000 || !marker || marker.length > 512)
        throw new SearchError("invalidInput");
      return await this.db.atomic(async () => {
        if (await this.get(storage, name)) throw new SearchError("conflict", 409);
        const now = this.now();
        await this.db.execute(
          "INSERT INTO panda_force_search_resources VALUES(?,?,?,?,NULL,'building',NULL,?,?,NULL,?,?)",
          [storage, name, recipe, marker, randomUUID(), now + leaseMs, now, now],
        );
        return (await this.get(storage, name))!;
      });
    });
  }
  async heartbeat(ticket: IndexResourceTicket) {
    return this.db.atomic(async () => {
      const row = await this.db.one(
        "SELECT 1 FROM panda_force_search_resources WHERE storage=? AND name=? AND token=? AND state IN ('building','ready') AND leaseUntil>?",
        [ticket.storage, ticket.name, ticket.token, this.now()],
      );
      if (!row) return false;
      await this.db.execute(
        "UPDATE panda_force_search_resources SET leaseUntil=?,updatedAt=? WHERE storage=? AND name=?",
        [this.now() + leaseMs, this.now(), ticket.storage, ticket.name],
      );
      return true;
    });
  }
  async release(ticket: IndexResourceTicket) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_search_resources SET token=NULL,leaseUntil=?,updatedAt=? WHERE storage=? AND name=? AND token=? AND state IN ('building','ready')",
        [this.now(), this.now(), ticket.storage, ticket.name, ticket.token],
      );
    });
  }
  async seal(ticket: IndexResourceTicket, physical: PhysicalIndexResource, reference: IndexReference) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const row = await this.get(ticket.storage, ticket.name);
        if (
          !row ||
          row.token !== ticket.token ||
          row.state !== "building" ||
          row.leaseUntil <= this.now() ||
          !this.matches(row, physical) ||
          reference.name !== row.name ||
          reference.provider !== "milvus" ||
          reference.integrity?.recipe !== row.recipe ||
          reference.integrity.format !== "milvus-seal/1"
        )
          return false;
        await this.db.execute(
          "UPDATE panda_force_search_resources SET identity=?,reference=?,state='ready',updatedAt=? WHERE storage=? AND name=?",
          [physical.identity, JSON.stringify(reference), this.now(), row.storage, row.name],
        );
        return true;
      });
    });
  }
  private matches(row: IndexResourceAllocation, physical: PhysicalIndexResource) {
    return (
      physical.name === row.name &&
      physical.marker === row.marker &&
      /^[1-9][0-9]{0,18}$/.test(physical.identity) &&
      BigInt(physical.identity) <= 9223372036854775807n &&
      (row.identity === null || row.identity === physical.identity)
    );
  }
  async protected(row: IndexResourceAllocation) {
    return await this.db.atomic(async () => {
      return (
        (row.token !== null && row.leaseUntil > this.now()) ||
        (await mysqlResourceReferenced(this.db, row.name)) ||
        !!(await this.db.one(
          "SELECT 1 FROM panda_force_search_resource_reads WHERE storage=? AND name=? AND leaseUntil>? LIMIT 1",
          [row.storage, row.name, this.now()],
        ))
      );
    });
  }
  async observe(storage: string, name: string, physical: PhysicalIndexResource | null) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const row = await this.get(storage, name);
        if (!row) return null;
        if (physical && (!this.matches(row, physical) || row.state === "deleted")) {
          if (row.state !== "unverified")
            await this.db.execute(
              "UPDATE panda_force_search_resources SET state='unverified',updatedAt=? WHERE storage=? AND name=?",
              [this.now(), storage, name],
            );
        } else if (row.state !== "unverified" && row.state !== "deleted") {
          const floor = (await mysqlReadReferenceBarrier(this.db)).floor,
            orphan = (await this.protected(row))
              ? null
              : row.orphanSince === null || row.orphanSince < floor
                ? this.now()
                : row.orphanSince,
            identity = row.identity ?? physical?.identity ?? null;
          if (row.identity !== identity || row.orphanSince !== orphan)
            await this.db.execute(
              "UPDATE panda_force_search_resources SET identity=?,orphanSince=?,updatedAt=? WHERE storage=? AND name=?",
              [identity, orphan, this.now(), storage, name],
            );
        }
        return (await this.get(storage, name))!;
      });
    });
  }
  async pin(storage: string, name: string) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const row = await this.get(storage, name);
        if (!row || !["building", "ready"].includes(row.state)) throw new SearchError("notReady", 409);
        const ticket = { storage, name, token: randomUUID() };
        await this.db.execute("INSERT INTO panda_force_search_resource_reads VALUES(?,?,?,?)", [
          storage,
          name,
          ticket.token,
          this.now() + leaseMs,
        ]);
        return ticket;
      });
    });
  }
  async heartbeatRead(ticket: IndexResourceTicket) {
    return this.db.atomic(async () => {
      const row = await this.db.one(
        "SELECT 1 FROM panda_force_search_resource_reads WHERE storage=? AND name=? AND token=? AND leaseUntil>? AND EXISTS(SELECT 1 FROM panda_force_search_resources r WHERE r.storage=panda_force_search_resource_reads.storage AND r.name=panda_force_search_resource_reads.name AND r.state IN ('building','ready'))",
        [ticket.storage, ticket.name, ticket.token, this.now()],
      );
      if (!row) return false;
      await this.db.execute(
        "UPDATE panda_force_search_resource_reads SET leaseUntil=? WHERE storage=? AND name=? AND token=?",
        [this.now() + leaseMs, ticket.storage, ticket.name, ticket.token],
      );
      return true;
    });
  }
  async unpin(ticket: IndexResourceTicket) {
    return await this.db.atomic(async () => {
      await this.db.execute("DELETE FROM panda_force_search_resource_reads WHERE storage=? AND name=? AND token=?", [
        ticket.storage,
        ticket.name,
        ticket.token,
      ]);
    });
  }
  async claimDrop(storage: string, name: string, physical: PhysicalIndexResource | null, immediate = false) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const row = await this.get(storage, name);
        const floor = (await mysqlReadReferenceBarrier(this.db)).floor;
        if (
          !row ||
          row.state === "unverified" ||
          row.state === "deleted" ||
          (physical && !this.matches(row, physical)) ||
          (await this.protected(row)) ||
          ((!immediate || row.createdAt <= floor) &&
            (row.orphanSince === null || row.orphanSince < floor || row.orphanSince + resourceGraceMs > this.now()))
        )
          return null;
        const ticket = { storage, name, token: randomUUID() };
        await this.db.execute(
          "UPDATE panda_force_search_resources SET state='retiring',token=?,leaseUntil=?,identity=COALESCE(identity,?),updatedAt=? WHERE storage=? AND name=?",
          [ticket.token, this.now() + leaseMs, physical?.identity ?? null, this.now(), storage, name],
        );
        return ticket;
      });
    });
  }
  async mayDrop(ticket: IndexResourceTicket, physical: PhysicalIndexResource | null) {
    return await this.db.atomic(async () => {
      const row = await this.get(ticket.storage, ticket.name);
      const floor = (await mysqlReadReferenceBarrier(this.db)).floor;
      return (
        !!row &&
        row.state === "retiring" &&
        row.token === ticket.token &&
        row.leaseUntil > this.now() &&
        !(await mysqlResourceReferenced(this.db, row.name)) &&
        (row.createdAt > floor ||
          (row.orphanSince !== null && row.orphanSince >= floor && row.orphanSince + resourceGraceMs <= this.now())) &&
        (!physical || this.matches(row, physical))
      );
    });
  }
  async deleted(ticket: IndexResourceTicket) {
    return await this.db.atomic(async () => {
      return (
        (
          await this.db.execute(
            "UPDATE panda_force_search_resources SET state='deleted',token=NULL,leaseUntil=0,updatedAt=? WHERE storage=? AND name=? AND token=? AND state='retiring' AND leaseUntil>?",
            [this.now(), ticket.storage, ticket.name, ticket.token, this.now()],
          )
        ).changes === 1
      );
    });
  }
}
