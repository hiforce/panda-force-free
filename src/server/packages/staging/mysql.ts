import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore } from "../../packages/mysql-ledger.js";
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
export class MySQLSourceStages extends MySQLLedger implements AsyncStore<SourceStageStore> {
  private capacity: SourceStageCapacity;
  private statement<T = Record<string, unknown>, P extends unknown[] = unknown[]>(statement: string) {
    return super.query<T, P>(
      statement.replaceAll("panda_force_package_source_", "panda_force_" + this.namespace + "_source_"),
    );
  }
  constructor(
    pool: SQL,
    capacity?: SourceStageCapacity,
    private namespace: "package" | "native_theme" | "native_slides" = "package",
  ) {
    super(
      pool,
      namespace === "package" ? "panda_force_package_stages_guard" : "panda_force_" + namespace + "_stages_guard",
      [
        "revision",
        "reservedBytes",
        "expiresAt",
        "createdAt",
        "updatedAt",
        "at",
        "ownBytes",
        "allBytes",
        "ownItems",
        "allItems",
        "count",
      ],
    );
    if (!["package", "native_theme", "native_slides"].includes(namespace))
      throw new SourceStageError("stageInvalidInput");
    this.capacity = stageCapacity(capacity);
  }
  private async row(actor: string, id: string): Promise<SourceStageRow> {
    const row = await this.statement<SourceStageRow, [string, string]>(
      "SELECT * FROM panda_force_package_source_stages WHERE actor=? AND id=?",
    ).get(actor, id);
    if (!row) throw new SourceStageError("stageNotFound");
    return row;
  }
  async read(actor: string, id: string) {
    return this.readSnapshot(async () => {
      return stageView(await this.row(actor, id));
    });
  }
  async candidates(now: number) {
    return this.readSnapshot(async () => {
      return await this.statement<SourceStageCandidate, [number]>(
        `SELECT actor,id,purpose,revision,state FROM panda_force_package_source_stages
      WHERE (state='reserved' AND JSON_UNQUOTE(JSON_EXTRACT(request,'$.source.kind'))='github') OR state IN('uploaded','removing')
      OR (state IN('uploading','acquiring','writing') AND expiresAt<=?) ORDER BY createdAt,id LIMIT 16`,
      ).all(now);
    });
  }
  async list(actor: string, purpose: SourceStagePurpose) {
    return this.readSnapshot(async () => {
      return (
        await this.statement<SourceStageRow, [string, SourceStagePurpose]>(
          "SELECT * FROM panda_force_package_source_stages WHERE actor=? AND purpose=? AND state!='removed' ORDER BY updatedAt DESC,id LIMIT 50",
        ).all(actor, purpose)
      ).map((row) => stageView(row));
    });
  }
  async events(actor: string, id: string) {
    return this.readSnapshot(async () => {
      await this.row(actor, id);
      return await this.statement<SourceStageEvent, [string]>(
        "SELECT revision,state,at,digest,failure FROM panda_force_package_source_stage_events WHERE id=? ORDER BY revision",
      ).all(id);
    });
  }
  private async emit(row: SourceStageRow) {
    await this.statement("INSERT INTO panda_force_package_source_stage_events VALUES(?,?,?,?,?,?)").run(
      row.id,
      row.revision,
      row.state,
      row.updatedAt,
      row.digest,
      row.failure,
    );
  }
  private async save(row: SourceStageRow) {
    row.revision++;
    await this.statement(
      "UPDATE panda_force_package_source_stages SET revision=?,state=?,reservedBytes=?,digest=?,origin=?,failure=?,token=?,expiresAt=?,updatedAt=? WHERE id=?",
    ).run(
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
    await this.emit(row);
    return stageView(row);
  }
  private expected(row: SourceStageRow, revision: number) {
    if (row.revision !== revision) throw new SourceStageError("stageConflict");
  }
  private held(row: SourceStageRow, claim: SourceStageClaim, now: number) {
    if (row.token !== claim.token || row.expiresAt === null || row.expiresAt <= now)
      throw new SourceStageError("stageConflict");
  }
  async operation(actor: string, operationId: string) {
    return this.readSnapshot(async () => {
      const row = await this.operationRow(actor, operationId);
      return row ? stageView(row) : null;
    });
  }
  private async operationRow(actor: string, operationId: string) {
    return await this.statement<SourceStageRow, [string, string]>(
      "SELECT * FROM panda_force_package_source_stages WHERE actor=? AND operationId=?",
    ).get(actor, operationId);
  }
  async replay(actor: string, operationId: string, fingerprint: string) {
    return this.readSnapshot(async () => {
      const row = await this.operationRow(actor, operationId);
      if (!row) return null;
      if (row.fingerprint !== fingerprint) throw new SourceStageError("stageConflict");
      return stageView(row);
    });
  }
  async create(value: SourceStageCreation, prepare: (id: string) => void) {
    return this.transaction(async () => {
      const existing = await this.replay(value.actor, value.operationId, value.fingerprint);
      if (existing) return existing;
      const usage = (await this.statement<
          {
            ownBytes: number;
            allBytes: number;
            ownItems: number;
            allItems: number;
          },
          [string, string]
        >(
          "SELECT COALESCE(SUM(CASE WHEN actor=? THEN reservedBytes ELSE 0 END),0) AS ownBytes,COALESCE(SUM(reservedBytes),0) AS allBytes,COALESCE(SUM(actor=?),0) AS ownItems,COUNT(*) AS allItems FROM panda_force_package_source_stages WHERE state!='removed'",
        ).get(value.actor, value.actor))!,
        records = (await this.statement<
          {
            count: number;
          },
          []
        >("SELECT COUNT(*) AS count FROM panda_force_package_source_stages").get())!.count;
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
      await this.statement(
        "INSERT INTO panda_force_package_source_stages (id,actor,operationId,purpose,request,limits,fingerprint,revision,state,reservedBytes,digest,origin,failure,token,expiresAt,createdAt,updatedAt,entryPolicy) VALUES(?,?,?,?,?,?,?,1,'reserved',?,NULL,NULL,NULL,NULL,NULL,?,?,'logical-links/v2')",
      ).run(
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
      const row = await this.row(value.actor, value.id);
      await this.emit(row);
      return stageView(row);
    });
  }
  async claim(actor: string, id: string, revision: number, now: number, leaseMs: number): Promise<SourceStageClaim> {
    return this.transaction(async () => {
      const row = await this.row(actor, id);
      this.expected(row, revision);
      if (!["reserved", "uploaded"].includes(row.state)) throw new SourceStageError("stageBusy");
      row.state = "acquiring";
      row.token = randomUUID();
      row.expiresAt = now + leaseMs;
      row.updatedAt = now;
      return Object.freeze({ stage: await this.save(row), token: row.token, expiresAt: row.expiresAt });
    });
  }
  async claimUpload(
    actor: string,
    id: string,
    revision: number,
    now: number,
    leaseMs: number,
  ): Promise<SourceStageClaim> {
    return this.transaction(async () => {
      const row = await this.row(actor, id);
      this.expected(row, revision);
      if (row.state !== "reserved" || stageView(row).request.source.kind !== "zip-upload")
        throw new SourceStageError("stageConflict");
      row.state = "uploading";
      row.token = randomUUID();
      row.expiresAt = now + leaseMs;
      row.updatedAt = now;
      return Object.freeze({ stage: await this.save(row), token: row.token, expiresAt: row.expiresAt });
    });
  }
  private async uploadReady(row: SourceStageRow, now: number) {
    row.state = "uploaded";
    row.failure = null;
    row.token = null;
    row.expiresAt = null;
    row.updatedAt = now;
    return await this.save(row);
  }
  async uploaded(actor: string, claim: SourceStageClaim, now: number) {
    return this.transaction(async () => {
      const row = await this.row(actor, claim.stage.id);
      this.held(row, claim, now);
      if (row.state !== "uploading") throw new SourceStageError("stageConflict");
      return await this.uploadReady(row, now);
    });
  }
  async restoreUpload(actor: string, id: string, revision: number, now: number) {
    return this.transaction(async () => {
      const row = await this.row(actor, id);
      this.expected(row, revision);
      if (row.state !== "failed" || row.digest !== null || stageView(row).request.source.kind !== "zip-upload")
        throw new SourceStageError("stageConflict");
      return await this.uploadReady(row, now);
    });
  }
  async bind(actor: string, claim: SourceStageClaim, digest: string, now: number) {
    return this.transaction(async () => {
      const row = await this.row(actor, claim.stage.id);
      this.held(row, claim, now);
      if (row.state !== "acquiring" || !/^[a-f0-9]{64}$/.test(digest)) throw new SourceStageError("stageConflict");
      row.state = "writing";
      row.digest = digest;
      row.updatedAt = now;
      return await this.save(row);
    });
  }
  private async ready(row: SourceStageRow, source: CapturedPackageSource, bytes: number, now: number) {
    if (row.digest !== source.digest || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > row.reservedBytes)
      throw new SourceStageError("stageConflict");
    row.state = "ready";
    row.origin = JSON.stringify(source.descriptor.origin);
    row.reservedBytes = bytes;
    row.failure = null;
    row.token = null;
    row.expiresAt = null;
    row.updatedAt = now;
    return await this.save(row);
  }
  async complete(actor: string, claim: SourceStageClaim, source: CapturedPackageSource, bytes: number, now: number) {
    return this.transaction(async () => {
      const row = await this.row(actor, claim.stage.id);
      this.held(row, claim, now);
      if (row.state !== "writing") throw new SourceStageError("stageConflict");
      return await this.ready(row, source, bytes, now);
    });
  }
  async fail(actor: string, claim: SourceStageClaim, failure: SourceStageFailure, now: number) {
    return this.transaction(async () => {
      const row = await this.row(actor, claim.stage.id);
      if (row.token !== claim.token || !["uploading", "acquiring", "writing"].includes(row.state)) return;
      row.state = "failed";
      row.failure = failure;
      row.token = null;
      row.expiresAt = null;
      row.updatedAt = now;
      await this.save(row);
    });
  }
  async recover(
    actor: string,
    id: string,
    revision: number,
    source: CapturedPackageSource,
    bytes: number,
    now: number,
  ) {
    return this.transaction(async () => {
      const row = await this.row(actor, id);
      this.expected(row, revision);
      if (!["writing", "failed"].includes(row.state)) throw new SourceStageError("stageConflict");
      if (row.expiresAt !== null && row.expiresAt > now) throw new SourceStageError("stageBusy");
      return await this.ready(row, source, bytes, now);
    });
  }
  async recovery(actor: string, id: string, revision: number, now: number) {
    return this.transaction(async () => {
      const row = await this.row(actor, id);
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
      return await this.save(row);
    });
  }
  private async change(
    actor: string,
    id: string,
    revision: number,
    now: number,
    state: "cancelled" | "removing" | "removed",
  ) {
    return await this.transaction(async () => {
      const row = await this.row(actor, id);
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
      return await this.save(row);
    });
  }
  async cancel(actor: string, id: string, revision: number, now: number) {
    return this.transaction(async () => {
      return await this.change(actor, id, revision, now, "cancelled");
    });
  }
  async removing(actor: string, id: string, revision: number, now: number) {
    return this.transaction(async () => {
      return await this.change(actor, id, revision, now, "removing");
    });
  }
  async removed(actor: string, id: string, revision: number, now: number) {
    return this.transaction(async () => {
      return await this.change(actor, id, revision, now, "removed");
    });
  }
}
