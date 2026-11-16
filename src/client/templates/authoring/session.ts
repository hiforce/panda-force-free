import type {
  DocumentTemplateDefinition,
  TemplateDraftDetail,
  TemplateDraftResult,
} from "../../../shared/templates/authoring/contracts.js";
import { stableJson } from "../../../shared/stable-json.js";
import { PluginApiError } from "../../plugins/api.js";

export interface TemplateSaveCommand {
  operationId: string;
  id: string;
  expectedRevision: number;
  definition: DocumentTemplateDefinition;
}
export interface TemplateRecoveryValue {
  schema: 1;
  baseRevision: number;
  working: DocumentTemplateDefinition;
  pending: TemplateSaveCommand | null;
}
export interface TemplateRecoveryPort {
  read(): TemplateRecoveryValue | null;
  write(value: TemplateRecoveryValue): void;
  clear(): void;
}
export interface TemplateSessionPort {
  save(command: TemplateSaveCommand): Promise<TemplateDraftResult>;
  detail(id: string): Promise<TemplateDraftDetail>;
}

/** The editor owns unsent text; the session owns generations, uncertain commands and recovery without DOM dependencies. */
export class TemplateAuthoringSession {
  working: DocumentTemplateDefinition;
  pending: TemplateSaveCommand | null = null;
  busy = false;
  conflict = false;
  removed = false;
  recoveryFailed = false;
  private workingJson: string;
  private savedJson: string;
  constructor(
    public saved: TemplateDraftDetail,
    private api: TemplateSessionPort,
    private recovery: TemplateRecoveryPort,
  ) {
    let local: TemplateRecoveryValue | null = null;
    try {
      local = recovery.read();
    } catch {
      this.recoveryFailed = true;
    }
    this.working = structuredClone(local?.working || saved.definition);
    this.workingJson = stableJson(this.working);
    this.savedJson = stableJson(saved.definition);
    if (local) {
      this.pending = local.pending;
      this.conflict = local.baseRevision !== saved.draft.revision && !this.pending;
    }
  }
  get dirty() {
    return this.workingJson !== this.savedJson;
  }
  get changed() {
    return this.dirty || !!this.pending || this.conflict;
  }
  update(definition: DocumentTemplateDefinition) {
    const json = stableJson(definition);
    if (json === this.workingJson) return;
    this.working = structuredClone(definition);
    this.workingJson = json;
  }
  persist() {
    try {
      if (this.changed)
        this.recovery.write({
          schema: 1,
          baseRevision: this.saved.draft.revision,
          working: this.working,
          pending: this.pending,
        });
      else this.recovery.clear();
      this.recoveryFailed = false;
      return true;
    } catch {
      this.recoveryFailed = true;
      return false;
    }
  }
  async save() {
    if (this.busy) return;
    if (this.conflict || this.removed) throw new PluginApiError(409, { messageId: "templates.draftConflict" });
    if (!this.pending && !this.dirty) return;
    this.pending ||= {
      operationId: crypto.randomUUID(),
      id: this.saved.draft.id,
      expectedRevision: this.saved.draft.revision,
      definition: structuredClone(this.working),
    };
    this.persist();
    const command = structuredClone(this.pending);
    this.busy = true;
    try {
      const result = await this.api.save(command),
        ack = result.acknowledgement;
      if (
        ack.operationId !== command.operationId ||
        ack.id !== command.id ||
        ack.revision !== command.expectedRevision + 1
      )
        throw new PluginApiError(503, { messageId: "plugins.packageUnavailable" });
      this.pending = null;
      if (!result.current) {
        this.removed = true;
        this.conflict = true;
        throw new PluginApiError(404, { messageId: "templates.draftNotFound" });
      }
      if (result.current.draft.revision !== ack.revision || result.current.draft.digest !== ack.digest) {
        this.conflict = true;
        throw new PluginApiError(409, { messageId: "templates.draftConflict" });
      }
      this.saved = result.current;
      this.savedJson = stableJson(result.current.definition);
      this.persist();
    } catch (error) {
      if (error instanceof PluginApiError && error.status >= 400 && error.status < 500) {
        this.pending = null;
        if (error.status === 409 || error.status === 404) this.conflict = true;
      }
      this.persist();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async reload() {
    if (this.busy) return;
    if (this.pending) await this.save();
    const current = await this.api.detail(this.saved.draft.id);
    this.saved = current;
    this.working = structuredClone(current.definition);
    this.savedJson = this.workingJson = stableJson(current.definition);
    this.pending = null;
    this.conflict = false;
    this.removed = false;
    this.persist();
  }
}
