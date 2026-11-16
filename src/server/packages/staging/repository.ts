import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import {
  SourceStageError,
  type SourceStageFailure,
  type SourceStageEvent,
  type SourceStagePurpose,
} from "../../../shared/packages/stages/contracts.js";
import type { SourceStageStore, SourceStageCreation, SourceStageClaim, SourceStageCandidate } from "./ports.js";
import { stageCapacity, stageView, type SourceStageRow, type SourceStageCapacity } from "./records.js";

/** Short metadata transactions reserve capacity and fence lifecycle changes; source IO runs outside them. */
export class SqliteSourceStages implements SourceStageStore {
  private capacity: SourceStageCapacity;
  constructor(
    private db: Database,
    capacity?: SourceStageCapacity,
  ) {
    this.capacity = stageCapacity(capacity);
  }
  private transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  private row(actor: string, id: string): SourceStageRow {
    const row = this.db
      .query<SourceStageRow, [string, string]>("SELECT * FROM package_source_stages WHERE actor=? AND id=?")
      .get(actor, id);
    if (!row) throw new SourceStageError("stageNotFound");
    return row;
  }
  read(actor: string, id: string) {
    return stageView(this.row(actor, id));
  }
  candidates(now: number) {
    return this.db
      .query<SourceStageCandidate, [number]>(
        `SELECT actor,id,purpose,revision,state FROM package_source_stages
      WHERE (state='reserved' AND json_extract(request,'$.source.kind')='github') OR state IN('uploaded','removing')
      OR (state IN('uploading','acquiring','writing') AND expiresAt<=?) ORDER BY createdAt,id LIMIT 16`,
      )
      .all(now);
  }
  list(actor: string, purpose: SourceStagePurpose) {
    return this.db
      .query<SourceStageRow, [string, SourceStagePurpose]>(
        "SELECT * FROM package_source_stages WHERE actor=? AND purpose=? AND state!='removed' ORDER BY updatedAt DESC,id LIMIT 50",
      )
      .all(actor, purpose)
      .map((row) => stageView(row));
  }
  events(actor: string, id: string) {
    this.row(actor, id);
    return this.db
      .query<SourceStageEvent, [string]>(
        "SELECT revision,state,at,digest,failure FROM package_source_stage_events WHERE id=? ORDER BY revision",
      )
      .all(id);
  }
  private emit(row: SourceStageRow) {
    this.db
      .query("INSERT INTO package_source_stage_events VALUES(?,?,?,?,?,?)")
      .run(row.id, row.revision, row.state, row.updatedAt, row.digest, row.failure);
  }
  private save(row: SourceStageRow) {
    row.revision++;
    this.db
      .query(
        "UPDATE package_source_stages SET revision=?,state=?,reservedBytes=?,digest=?,origin=?,failure=?,token=?,expiresAt=?,updatedAt=? WHERE id=?",
      )
      .run(
        row.revision,
        row.state,
        row.reservedBytes,
        row.digest,
        row.origin,
        row.failure,
        row.token,
        row.expiresAt,
        row.updatedAt,
        row.id,
      );
    this.emit(row);
    return stageView(row);
  }
  private expected(row: SourceStageRow, revision: number) {
    if (row.revision !== revision) throw new SourceStageError("stageConflict");
  }
  private held(row: SourceStageRow, claim: SourceStageClaim, now: number) {
    if (row.token !== claim.token || row.expiresAt === null || row.expiresAt <= now)
      throw new SourceStageError("stageConflict");
  }
  operation(actor: string, operationId: string) {
    const row = this.operationRow(actor, operationId);
    return row ? stageView(row) : null;
  }
  private operationRow(actor: string, operationId: string) {
    return this.db
      .query<SourceStageRow, [string, string]>("SELECT * FROM package_source_stages WHERE actor=? AND operationId=?")
      .get(actor, operationId);
  }
  replay(actor: string, operationId: string, fingerprint: string) {
    const row = this.operationRow(actor, operationId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new SourceStageError("stageConflict");
    return stageView(row);
  }
  create(value: SourceStageCreation, prepare: (id: string) => void) {
    return this.transaction(() => {
      const existing = this.replay(value.actor, value.operationId, value.fingerprint);
      if (existing) return existing;
      const usage = this.db
          .query<{ ownBytes: number; allBytes: number; ownItems: number; allItems: number }, [string, string]>(
            "SELECT COALESCE(SUM(CASE WHEN actor=? THEN reservedBytes ELSE 0 END),0) AS ownBytes,COALESCE(SUM(reservedBytes),0) AS allBytes,COALESCE(SUM(actor=?),0) AS ownItems,COUNT(*) AS allItems FROM package_source_stages WHERE state!='removed'",
          )
          .get(value.actor, value.actor)!,
        records = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM package_source_stages").get()!
          .count;
      if (
        !Number.isSafeInteger(value.reservedBytes) ||
        value.reservedBytes < 1 ||
        usage.ownBytes + value.reservedBytes > this.capacity.ownerBytes ||
        usage.allBytes + value.reservedBytes > this.capacity.globalBytes ||
        usage.ownItems >= this.capacity.ownerItems ||
        usage.allItems >= this.capacity.globalItems ||
        records >= 65536
      )
        throw new SourceStageError("stageCapacity");
      this.db
        .query(
          "INSERT INTO package_source_stages (id,actor,operationId,purpose,request,limits,fingerprint,revision,state,reservedBytes,digest,origin,failure,token,expiresAt,createdAt,updatedAt,entryPolicy) VALUES(?,?,?,?,?,?,?,1,'reserved',?,NULL,NULL,NULL,NULL,NULL,?,?,'logical-links/v2')",
        )
        .run(
          value.id,
          value.actor,
          value.operationId,
          value.purpose,
          JSON.stringify(value.request),
          JSON.stringify(value.limits),
          value.fingerprint,
          value.reservedBytes,
          value.now,
          value.now,
        );
      // This callback may create one empty namespace synchronously; it must never acquire or write source bodies.
      prepare(value.id);
      const row = this.row(value.actor, value.id);
      this.emit(row);
      return stageView(row);
    });
  }
  claim(actor: string, id: string, revision: number, now: number, leaseMs: number): SourceStageClaim {
    return this.transaction(() => {
      const row = this.row(actor, id);
      this.expected(row, revision);
      if (!["reserved", "uploaded"].includes(row.state)) throw new SourceStageError("stageBusy");
      row.state = "acquiring";
      row.token = randomUUID();
      row.expiresAt = now + leaseMs;
      row.updatedAt = now;
      return Object.freeze({ stage: this.save(row), token: row.token, expiresAt: row.expiresAt });
    });
  }
  claimUpload(actor: string, id: string, revision: number, now: number, leaseMs: number): SourceStageClaim {
    return this.transaction(() => {
      const row = this.row(actor, id);
      this.expected(row, revision);
      if (row.state !== "reserved" || stageView(row).request.source.kind !== "zip-upload")
        throw new SourceStageError("stageConflict");
      row.state = "uploading";
      row.token = randomUUID();
      row.expiresAt = now + leaseMs;
      row.updatedAt = now;
      return Object.freeze({ stage: this.save(row), token: row.token, expiresAt: row.expiresAt });
    });
  }
  private uploadReady(row: SourceStageRow, now: number) {
    row.state = "uploaded";
    row.failure = null;
    row.token = null;
    row.expiresAt = null;
    row.updatedAt = now;
    return this.save(row);
  }
  uploaded(actor: string, claim: SourceStageClaim, now: number) {
    return this.transaction(() => {
      const row = this.row(actor, claim.stage.id);
      this.held(row, claim, now);
      if (row.state !== "uploading") throw new SourceStageError("stageConflict");
      return this.uploadReady(row, now);
    });
  }
  restoreUpload(actor: string, id: string, revision: number, now: number) {
    return this.transaction(() => {
      const row = this.row(actor, id);
      this.expected(row, revision);
      if (row.state !== "failed" || row.digest !== null || stageView(row).request.source.kind !== "zip-upload")
        throw new SourceStageError("stageConflict");
      return this.uploadReady(row, now);
    });
  }
  bind(actor: string, claim: SourceStageClaim, digest: string, now: number) {
    return this.transaction(() => {
      const row = this.row(actor, claim.stage.id);
      this.held(row, claim, now);
      if (row.state !== "acquiring" || !/^[a-f0-9]{64}$/.test(digest)) throw new SourceStageError("stageConflict");
      row.state = "writing";
      row.digest = digest;
      row.updatedAt = now;
      return this.save(row);
    });
  }
  private ready(row: SourceStageRow, source: CapturedPackageSource, bytes: number, now: number) {
    if (row.digest !== source.digest || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > row.reservedBytes)
      throw new SourceStageError("stageConflict");
    row.state = "ready";
    row.origin = JSON.stringify(source.descriptor.origin);
    row.reservedBytes = bytes;
    row.failure = null;
    row.token = null;
    row.expiresAt = null;
    row.updatedAt = now;
    return this.save(row);
  }
  complete(actor: string, claim: SourceStageClaim, source: CapturedPackageSource, bytes: number, now: number) {
    return this.transaction(() => {
      const row = this.row(actor, claim.stage.id);
      this.held(row, claim, now);
      if (row.state !== "writing") throw new SourceStageError("stageConflict");
      return this.ready(row, source, bytes, now);
    });
  }
  fail(actor: string, claim: SourceStageClaim, failure: SourceStageFailure, now: number) {
    this.transaction(() => {
      const row = this.row(actor, claim.stage.id);
      if (row.token !== claim.token || !["uploading", "acquiring", "writing"].includes(row.state)) return;
      row.state = "failed";
      row.failure = failure;
      row.token = null;
      row.expiresAt = null;
      row.updatedAt = now;
      this.save(row);
    });
  }
  recover(actor: string, id: string, revision: number, source: CapturedPackageSource, bytes: number, now: number) {
    return this.transaction(() => {
      const row = this.row(actor, id);
      this.expected(row, revision);
      if (!["writing", "failed"].includes(row.state)) throw new SourceStageError("stageConflict");
      if (row.expiresAt !== null && row.expiresAt > now) throw new SourceStageError("stageBusy");
      return this.ready(row, source, bytes, now);
    });
  }
  recovery(actor: string, id: string, revision: number, now: number) {
    return this.transaction(() => {
      const row = this.row(actor, id);
      this.expected(row, revision);
      if (!["uploading", "acquiring", "writing", "failed"].includes(row.state))
        throw new SourceStageError("stageConflict");
      if (row.expiresAt !== null && row.expiresAt > now) throw new SourceStageError("stageBusy");
      if (row.state === "failed") return stageView(row);
      row.state = "failed";
      row.failure = "interrupted";
      row.token = null;
      row.expiresAt = null;
      row.updatedAt = now;
      return this.save(row);
    });
  }
  private change(
    actor: string,
    id: string,
    revision: number,
    now: number,
    state: "cancelled" | "removing" | "removed",
  ) {
    return this.transaction(() => {
      const row = this.row(actor, id);
      this.expected(row, revision);
      if (
        state === "cancelled" &&
        !["reserved", "uploading", "uploaded", "acquiring", "writing", "failed"].includes(row.state)
      )
        throw new SourceStageError("stageConflict");
      if (state === "removed" && row.state !== "removing") throw new SourceStageError("stageConflict");
      if (state === "removing" && ["removing", "removed"].includes(row.state)) return stageView(row);
      row.state = state;
      row.failure = null;
      row.token = null;
      row.expiresAt = null;
      row.updatedAt = now;
      if (state === "removed") row.reservedBytes = 0;
      return this.save(row);
    });
  }
  cancel(actor: string, id: string, revision: number, now: number) {
    return this.change(actor, id, revision, now, "cancelled");
  }
  removing(actor: string, id: string, revision: number, now: number) {
    return this.change(actor, id, revision, now, "removing");
  }
  removed(actor: string, id: string, revision: number, now: number) {
    return this.change(actor, id, revision, now, "removed");
  }
}
