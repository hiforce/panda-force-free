import type { Database } from "bun:sqlite";
import type { SkillRegistryStore, SkillRegistryCommand, SkillMutation } from "../ports.js";
import type { SkillCapture } from "../../../shared/skills/registry.js";
import { migrateSkills } from "./schema.js";
import { SkillRegistryReads } from "./reads.js";
import { SkillRegistryWrites } from "./writes.js";
import { SkillMutationJournal } from "./journal.js";
import { SkillCaptures } from "./captures.js";
/** Composition of small persistence units; no source acquisition, model calls or filesystem paths. */
export class SqliteSkillRegistry implements SkillRegistryStore {
  private reads: SkillRegistryReads;
  private writes: SkillRegistryWrites;
  private journal: SkillMutationJournal;
  private captures: SkillCaptures;
  constructor(db: Database) {
    migrateSkills(db);
    this.reads = new SkillRegistryReads(db);
    this.journal = new SkillMutationJournal(db, this.reads);
    this.writes = new SkillRegistryWrites(db, this.reads, this.journal);
    this.captures = new SkillCaptures(db, this.reads);
  }
  revision() {
    return this.reads.revision();
  }
  get(id: string, version: string) {
    return this.reads.get(id, version);
  }
  detail(id: string, version: string) {
    return this.reads.detail(id, version);
  }
  active(id: string) {
    return this.reads.active(id);
  }
  known(id: string) {
    return this.reads.known(id);
  }
  list(cursor?: string, limit?: number, activeOnly = false) {
    return this.reads.list(cursor, limit, activeOnly);
  }
  audit(after?: number, limit?: number) {
    return this.reads.audit(after, limit);
  }
  replay(actor: string, id: string, request: string) {
    return this.journal.replay(actor, id, request);
  }
  apply(command: SkillRegistryCommand, mutation: SkillMutation) {
    return this.writes.apply(command, mutation);
  }
  captured(owner: string, id: string, request: string) {
    return this.captures.get(owner, id, request);
  }
  captureById(owner: string, id: string) {
    return this.captures.get(owner, id);
  }
  capture(value: SkillCapture, request: string, expectedRevision: number) {
    return this.captures.put(value, request, expectedRevision);
  }
}
