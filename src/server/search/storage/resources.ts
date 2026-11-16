import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import type { IndexReference } from "../ports.js";
import type {
  IndexResourceAllocation,
  IndexResourceTicket,
  IndexResourceOwnership,
  PhysicalIndexResource,
} from "../resources/contracts.js";
import { resourceReferenced } from "./resource-references.js";
import { validResourceAllocation } from "../resources/validation.js";
import { IndexIntegrityError } from "../integrity.js";
import { readReferenceBarrier } from "./reference-barrier.js";

const leaseMs = 120000;
export const resourceGraceMs = 300000;
const validName = (value: string) => /^[a-f0-9]{64}$/.test(value);

/** Durable ownership, observation and fenced claims are separate from upstream IO and maintenance scheduling. */
export class SearchIndexResources implements IndexResourceOwnership {
  constructor(
    private db: Database,
    private now = Date.now,
  ) {}
  get(storage: string, name: string) {
    const row = this.db
      .query<IndexResourceAllocation, [string, string]>("SELECT * FROM search_resources WHERE storage=? AND name=?")
      .get(storage, name);
    if (row && !validResourceAllocation(row)) throw new IndexIntegrityError("unverified");
    return row;
  }
  page(storage: string, after = "") {
    return this.db
      .query<{ name: string }, [string, string]>(
        "SELECT name FROM search_resources WHERE storage=? AND name>? AND state!='deleted' ORDER BY name LIMIT 32",
      )
      .all(storage, after);
  }
  reserve(storage: string, name: string, recipe: string, marker: string) {
    if (!validName(storage) || !validName(name) || !recipe || recipe.length > 1000 || !marker || marker.length > 512)
      throw new SearchError("invalidInput");
    return this.db
      .transaction(() => {
        if (this.get(storage, name)) throw new SearchError("conflict", 409);
        const now = this.now();
        this.db
          .query("INSERT INTO search_resources VALUES(?,?,?,?,NULL,'building',NULL,?,?,NULL,?,?)")
          .run(storage, name, recipe, marker, randomUUID(), now + leaseMs, now, now);
        return this.get(storage, name)!;
      })
      .immediate();
  }
  heartbeat(ticket: IndexResourceTicket) {
    return (
      this.db
        .query(
          "UPDATE search_resources SET leaseUntil=?,updatedAt=? WHERE storage=? AND name=? AND token=? AND state IN ('building','ready') AND leaseUntil>?",
        )
        .run(this.now() + leaseMs, this.now(), ticket.storage, ticket.name, ticket.token, this.now()).changes === 1
    );
  }
  release(ticket: IndexResourceTicket) {
    this.db
      .query(
        "UPDATE search_resources SET token=NULL,leaseUntil=?,updatedAt=? WHERE storage=? AND name=? AND token=? AND state IN ('building','ready')",
      )
      .run(this.now(), this.now(), ticket.storage, ticket.name, ticket.token);
  }
  seal(ticket: IndexResourceTicket, physical: PhysicalIndexResource, reference: IndexReference) {
    return this.db
      .transaction(() => {
        const row = this.get(ticket.storage, ticket.name);
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
        this.db
          .query(
            "UPDATE search_resources SET identity=?,reference=?,state='ready',updatedAt=? WHERE storage=? AND name=?",
          )
          .run(physical.identity, JSON.stringify(reference), this.now(), row.storage, row.name);
        return true;
      })
      .immediate();
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
  protected(row: IndexResourceAllocation) {
    return (
      (row.token !== null && row.leaseUntil > this.now()) ||
      resourceReferenced(this.db, row.name) ||
      !!this.db
        .query("SELECT 1 FROM search_resource_reads WHERE storage=? AND name=? AND leaseUntil>? LIMIT 1")
        .get(row.storage, row.name, this.now())
    );
  }
  observe(storage: string, name: string, physical: PhysicalIndexResource | null) {
    return this.db
      .transaction(() => {
        const row = this.get(storage, name);
        if (!row) return null;
        if (physical && (!this.matches(row, physical) || row.state === "deleted")) {
          if (row.state !== "unverified")
            this.db
              .query("UPDATE search_resources SET state='unverified',updatedAt=? WHERE storage=? AND name=?")
              .run(this.now(), storage, name);
        } else if (row.state !== "unverified" && row.state !== "deleted") {
          const floor = readReferenceBarrier(this.db).floor,
            orphan = this.protected(row)
              ? null
              : row.orphanSince === null || row.orphanSince < floor
                ? this.now()
                : row.orphanSince,
            identity = row.identity ?? physical?.identity ?? null;
          if (row.identity !== identity || row.orphanSince !== orphan)
            this.db
              .query("UPDATE search_resources SET identity=?,orphanSince=?,updatedAt=? WHERE storage=? AND name=?")
              .run(identity, orphan, this.now(), storage, name);
        }
        return this.get(storage, name)!;
      })
      .immediate();
  }
  pin(storage: string, name: string) {
    return this.db
      .transaction(() => {
        const row = this.get(storage, name);
        if (!row || !["building", "ready"].includes(row.state)) throw new SearchError("notReady", 409);
        const ticket = { storage, name, token: randomUUID() };
        this.db
          .query("INSERT INTO search_resource_reads VALUES(?,?,?,?)")
          .run(storage, name, ticket.token, this.now() + leaseMs);
        return ticket;
      })
      .immediate();
  }
  heartbeatRead(ticket: IndexResourceTicket) {
    return (
      this.db
        .query(
          "UPDATE search_resource_reads SET leaseUntil=? WHERE storage=? AND name=? AND token=? AND leaseUntil>? AND EXISTS(SELECT 1 FROM search_resources r WHERE r.storage=search_resource_reads.storage AND r.name=search_resource_reads.name AND r.state IN ('building','ready'))",
        )
        .run(this.now() + leaseMs, ticket.storage, ticket.name, ticket.token, this.now()).changes === 1
    );
  }
  unpin(ticket: IndexResourceTicket) {
    this.db
      .query("DELETE FROM search_resource_reads WHERE storage=? AND name=? AND token=?")
      .run(ticket.storage, ticket.name, ticket.token);
  }
  claimDrop(storage: string, name: string, physical: PhysicalIndexResource | null, immediate = false) {
    return this.db
      .transaction(() => {
        const row = this.get(storage, name);
        const floor = readReferenceBarrier(this.db).floor;
        if (
          !row ||
          row.state === "unverified" ||
          row.state === "deleted" ||
          (physical && !this.matches(row, physical)) ||
          this.protected(row) ||
          ((!immediate || row.createdAt <= floor) &&
            (row.orphanSince === null || row.orphanSince < floor || row.orphanSince + resourceGraceMs > this.now()))
        )
          return null;
        const ticket = { storage, name, token: randomUUID() };
        this.db
          .query(
            "UPDATE search_resources SET state='retiring',token=?,leaseUntil=?,identity=COALESCE(identity,?),updatedAt=? WHERE storage=? AND name=?",
          )
          .run(ticket.token, this.now() + leaseMs, physical?.identity ?? null, this.now(), storage, name);
        return ticket;
      })
      .immediate();
  }
  mayDrop(ticket: IndexResourceTicket, physical: PhysicalIndexResource | null) {
    const row = this.get(ticket.storage, ticket.name);
    const floor = readReferenceBarrier(this.db).floor;
    return (
      !!row &&
      row.state === "retiring" &&
      row.token === ticket.token &&
      row.leaseUntil > this.now() &&
      !resourceReferenced(this.db, row.name) &&
      (row.createdAt > floor ||
        (row.orphanSince !== null && row.orphanSince >= floor && row.orphanSince + resourceGraceMs <= this.now())) &&
      (!physical || this.matches(row, physical))
    );
  }
  deleted(ticket: IndexResourceTicket) {
    return (
      this.db
        .query(
          "UPDATE search_resources SET state='deleted',token=NULL,leaseUntil=0,updatedAt=? WHERE storage=? AND name=? AND token=? AND state='retiring' AND leaseUntil>?",
        )
        .run(this.now(), ticket.storage, ticket.name, ticket.token, this.now()).changes === 1
    );
  }
}
