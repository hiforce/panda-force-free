import { stableJson } from "../../../shared/stable-json.js";
import type {
  DocumentEditorSnapshot,
  DocumentWorkingContent,
  DocumentCheckpointResult,
  DocumentDraftAcknowledgement,
} from "../../../shared/documents/working-copy.js";
import type { FileEditorApi, FileEditorCommand } from "./api.js";
import type { FileEditorRecovery, FileRecoveryPort } from "./recovery.js";
import { DocumentApiError } from "../api.js";

const source = (snapshot: DocumentEditorSnapshot): DocumentWorkingContent => {
  const { title, locale, content, body, resources } = snapshot.saved.revision;
  return { title, locale, content, ...(body ? { body } : {}), resources: resources ?? [] };
};
const same = (a: DocumentWorkingContent, b: DocumentWorkingContent) => stableJson(a) === stableJson(b);

/** One document owns a serial command stream. Exact pending requests survive reload; acknowledgements never replace newer typing. */
export class FileEditorSession {
  snapshot: DocumentEditorSnapshot;
  working: DocumentWorkingContent;
  private acknowledged: DocumentWorkingContent;
  private pending: FileEditorCommand | null = null;
  busy = false;
  conflict = false;
  private constructor(
    private api: FileEditorApi,
    private recovery: FileRecoveryPort,
    snapshot: DocumentEditorSnapshot,
    private changed: () => void,
  ) {
    this.snapshot = snapshot;
    this.working = structuredClone(snapshot.working);
    this.acknowledged = structuredClone(snapshot.working);
    this.conflict = snapshot.draft.stale;
  }
  static async open(api: FileEditorApi, recovery: FileRecoveryPort, changed: () => void) {
    const local = recovery.read(),
      snapshot = await api.open(),
      session = new FileEditorSession(api, recovery, snapshot, changed);
    if (local) {
      session.working = local.working;
      session.acknowledged = local.acknowledged;
      session.pending = local.pending;
      if (local.pending) {
        session.snapshot = {
          ...snapshot,
          draft: { ...snapshot.draft, version: local.version, baseRevisionId: local.baseRevisionId },
        };
      } else if (local.baseRevisionId !== snapshot.saved.revision.id || local.version !== snapshot.draft.version) {
        if (same(local.working, snapshot.working)) session.acknowledged = structuredClone(snapshot.working);
        else session.conflict = true;
      }
    }
    return session;
  }
  get uncertain() {
    return this.pending !== null;
  }
  get unsent() {
    return !same(this.working, this.acknowledged);
  }
  get dirty() {
    return !same(this.working, source(this.snapshot));
  }
  update(value: DocumentWorkingContent) {
    this.working = structuredClone(value);
    this.persist();
    this.changed();
  }
  async refreshSaved(minimumVersion: number) {
    const blocked = () => this.busy || this.uncertain || this.unsent || this.dirty || this.conflict;
    if (blocked()) throw new DocumentApiError(409, { messageId: "documents.conflict" });
    const fresh = await this.api.open();
    if (
      blocked() ||
      fresh.saved.document.id !== this.snapshot.saved.document.id ||
      fresh.saved.document.revision < minimumVersion
    )
      throw new DocumentApiError(409, { messageId: "documents.conflict" });
    this.snapshot = fresh;
    this.working = structuredClone(fresh.working);
    this.acknowledged = structuredClone(fresh.working);
    this.conflict = fresh.draft.stale;
    this.persist();
    this.changed();
  }
  persist() {
    const value: FileEditorRecovery = {
      baseRevisionId: this.snapshot.draft.baseRevisionId,
      version: this.snapshot.draft.version,
      working: this.working,
      acknowledged: this.acknowledged,
      pending: this.pending,
    };
    this.recovery.write(this.pending || this.unsent || this.conflict ? value : null);
  }
  private async send(command: FileEditorCommand) {
    this.pending = structuredClone(command);
    this.persist();
    this.changed();
    const submitted = structuredClone(this.working);
    const result = await this.api.execute(command);
    if (command.kind === "autosave" || command.kind === "discard") {
      const receipt = result as DocumentDraftAcknowledgement;
      this.snapshot.draft = {
        ...this.snapshot.draft,
        version: receipt.version,
        baseRevisionId: receipt.baseRevisionId,
        dirty: true,
        updatedAt: receipt.updatedAt,
      };
      this.acknowledged = command.kind === "autosave" ? structuredClone(command.input.working!) : source(this.snapshot);
      if (command.kind === "discard") {
        this.snapshot.draft.baseRevisionId = this.snapshot.saved.revision.id;
        this.snapshot.draft.dirty = false;
        this.snapshot.draft.stale = false;
        this.conflict = false;
        if (same(this.working, submitted)) this.working = structuredClone(this.acknowledged);
      }
    } else {
      const saved = result as DocumentCheckpointResult;
      this.snapshot.saved = saved.detail;
      this.snapshot.draft = {
        ...this.snapshot.draft,
        savedRevisionId: saved.detail.revision.id,
        baseRevisionId: saved.detail.revision.id,
        dirty: false,
        stale: false,
      };
      this.acknowledged = source(this.snapshot);
      if (command.kind === "restore" && same(this.working, submitted))
        this.working = structuredClone(this.acknowledged);
    }
    this.pending = null;
    this.persist();
  }
  private async run(work: () => Promise<void>, allowConflict = false) {
    if (this.busy) return;
    if (this.conflict && !allowConflict && !this.pending)
      throw new DocumentApiError(409, { messageId: "documents.conflict" });
    this.busy = true;
    this.changed();
    try {
      await work();
    } catch (error) {
      if (
        error instanceof DocumentApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        this.pending = null;
        if (error.status === 409) this.conflict = true;
        this.persist();
      }
      throw error;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  private async synchronize() {
    if (this.pending) await this.send(this.pending);
    if (!this.unsent) return;
    await this.send({
      kind: "autosave",
      input: {
        operationId: crypto.randomUUID(),
        version: this.snapshot.draft.version,
        baseRevisionId: this.snapshot.draft.baseRevisionId,
        working: structuredClone(this.working),
      },
    });
  }
  autosave() {
    return this.run(() => this.synchronize());
  }
  save() {
    return this.run(async () => {
      await this.synchronize();
      if (same(this.acknowledged, source(this.snapshot))) return;
      await this.send({
        kind: "save",
        input: {
          operationId: crypto.randomUUID(),
          revisionId: this.snapshot.saved.revision.id,
          draftVersion: this.snapshot.draft.version,
        },
      });
    });
  }
  discard() {
    return this.run(async () => {
      const current = await this.api.open();
      this.snapshot = current;
      await this.send({
        kind: "discard",
        input: {
          operationId: crypto.randomUUID(),
          version: current.draft.version,
          baseRevisionId: current.saved.revision.id,
        },
      });
    }, true);
  }
  restore(revisionId: string) {
    return this.run(async () => {
      if (this.pending || this.dirty || this.unsent)
        throw new DocumentApiError(409, { messageId: "documents.unsaved" });
      await this.send({
        kind: "restore",
        input: {
          operationId: crypto.randomUUID(),
          revisionId: this.snapshot.saved.revision.id,
          draftVersion: this.snapshot.draft.version,
          restoreRevisionId: revisionId,
        },
      });
    });
  }
}
