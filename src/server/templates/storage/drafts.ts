import type { Database } from "bun:sqlite";
import type {
  TemplateDraftRecord,
  TemplateDraftAcknowledgement,
} from "../../../shared/templates/authoring/contracts.js";
import type { VerifiedPortableTemplate } from "../../../shared/templates/portable/contracts.js";
import { validatePortableTemplateManifest } from "../../../shared/templates/portable/manifest.js";
import type { TemplateDraftStore, TemplateDraftMutation } from "../authoring/ports.js";
import { PortableRegistryError } from "../portable/errors.js";

type Row = Omit<TemplateDraftRecord, "manifest" | "removed"> & { manifest: string; removed: number };
function record(row: Row): TemplateDraftRecord {
  try {
    if (!/^[a-f0-9]{64}$/.test(row.digest)) throw Error();
    return { ...row, manifest: validatePortableTemplateManifest(JSON.parse(row.manifest)), removed: row.removed === 1 };
  } catch {
    throw new PortableRegistryError("unavailable");
  }
}
/** Draft content is addressed in the immutable file store; this adapter records ownership and optimistic generations. */
export class SqliteTemplateDrafts implements TemplateDraftStore {
  constructor(private db: Database) {}
  list(actor: string) {
    return this.db
      .query<Row, [string]>(
        "SELECT * FROM portable_template_drafts WHERE owner=? AND removed=0 ORDER BY updatedAt DESC,id LIMIT 64",
      )
      .all(actor)
      .map(record);
  }
  read(actor: string, id: string) {
    const row = this.db
      .query<Row, [string, string]>("SELECT * FROM portable_template_drafts WHERE owner=? AND id=?")
      .get(actor, id);
    if (!row) throw new PortableRegistryError("draftNotFound");
    return record(row);
  }
  prove(actor: string, id: string, revision: number, digest: string) {
    this.read(actor, id);
    const row = this.db
      .query<{ digest: string }, [string, number]>(
        "SELECT digest FROM portable_template_draft_revisions WHERE id=? AND revision=?",
      )
      .get(id, revision);
    if (!row || row.digest !== digest) throw new PortableRegistryError("draftNotFound");
  }
  replay(actor: string, operationId: string, request: string) {
    const row = this.db
      .query<{ request: string; receipt: string }, [string, string]>(
        "SELECT request,receipt FROM portable_template_draft_operations WHERE owner=? AND operationId=?",
      )
      .get(actor, operationId);
    if (!row) return null;
    if (row.request !== request) throw new PortableRegistryError("operationConflict");
    return JSON.parse(row.receipt) as TemplateDraftAcknowledgement;
  }
  save(template: VerifiedPortableTemplate, command: TemplateDraftMutation) {
    return this.db
      .transaction(() => {
        const replay = this.replay(command.actor, command.operationId, command.request);
        if (replay) return replay;
        const existing = this.db
          .query<Row, [string]>("SELECT * FROM portable_template_drafts WHERE id=?")
          .get(command.id);
        if (existing && existing.owner !== command.actor) throw new PortableRegistryError("draftNotFound");
        if ((existing?.revision ?? 0) !== command.expectedRevision || existing?.removed)
          throw new PortableRegistryError("draftConflict");
        if (!existing) {
          const count = this.db
            .query<{ count: number }, [string]>(
              "SELECT count(*) AS count FROM portable_template_drafts WHERE owner=? AND removed=0",
            )
            .get(command.actor)!.count;
          const total = this.db
            .query<{ count: number }, []>("SELECT count(*) AS count FROM portable_template_drafts")
            .get()!.count;
          if (count >= 64 || total >= 2048) throw new PortableRegistryError("storageFull");
        }
        const revision = (existing?.revision ?? 0) + 1;
        this.db
          .query(
            "INSERT INTO portable_template_drafts VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,manifest=excluded.manifest,updatedAt=excluded.updatedAt",
          )
          .run(
            command.id,
            command.actor,
            revision,
            template.digest,
            JSON.stringify(template.manifest),
            existing?.createdAt ?? command.now,
            command.now,
          );
        this.db
          .query("INSERT INTO portable_template_draft_revisions VALUES(?,?,?)")
          .run(command.id, revision, template.digest);
        return this.receipt(command, {
          operationId: command.operationId,
          id: command.id,
          revision,
          digest: template.digest,
          removed: false,
        });
      })
      .immediate();
  }
  remove(command: TemplateDraftMutation) {
    return this.db
      .transaction(() => {
        const replay = this.replay(command.actor, command.operationId, command.request);
        if (replay) return replay;
        const draft = this.read(command.actor, command.id);
        if (draft.revision !== command.expectedRevision || draft.removed)
          throw new PortableRegistryError("draftConflict");
        const revision = draft.revision + 1;
        this.db
          .query("UPDATE portable_template_drafts SET revision=?,removed=1,updatedAt=? WHERE id=? AND owner=?")
          .run(revision, command.now, command.id, command.actor);
        return this.receipt(command, {
          operationId: command.operationId,
          id: command.id,
          revision,
          digest: draft.digest,
          removed: true,
        });
      })
      .immediate();
  }
  private receipt(command: TemplateDraftMutation, value: TemplateDraftAcknowledgement) {
    this.db
      .query("INSERT INTO portable_template_draft_operations VALUES(?,?,?,?,?)")
      .run(command.actor, command.operationId, command.request, JSON.stringify(value), command.now);
    return value;
  }
}
