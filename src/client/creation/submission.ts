import type { CreationRequest, CreationTaskView } from "../../shared/creation/contracts.js";
import { creationApi, CreationApiError } from "./api.js";
import type { CreationDraft } from "./drafts.js";
import { CreationDrafts, restoreCreationDraft } from "./drafts.js";

/** An ambiguous POST retains its exact request. Late acknowledgements cannot replace a newer browser draft. */
export class CreationSubmission {
  constructor(
    readonly state: CreationDraft,
    private readonly store: CreationDrafts,
    private readonly api: typeof creationApi = creationApi,
  ) {}
  remember(value: Omit<CreationDraft, "pending">) {
    if (this.state.pending) return;
    Object.assign(this.state, structuredClone(value), { skillsVersion: 2 });
    this.store.save(this.state);
  }
  private finish(requestId: string, task?: CreationTaskView) {
    if (this.state.pending?.id !== requestId) return;
    const latest = this.store.load();
    this.state.pending = null;
    if (task) {
      this.state.prompt = "";
      this.state.selections = [];
    }
    Object.assign(this.state, restoreCreationDraft(this.state));
    if (latest?.pending?.id === requestId) this.store.save(this.state);
  }
  async confirm() {
    const request = this.state.pending;
    if (!request) return null;
    try {
      const result = await this.api.detail(request.id);
      this.finish(request.id, result.task);
      return result.task;
    } catch {
      return null;
    }
  }
  async send(intent: () => CreationRequest) {
    if (!this.state.pending) {
      this.state.pending = structuredClone(intent());
      this.store.save(this.state);
    }
    const request = this.state.pending;
    try {
      const result = await this.api.submit(request);
      this.finish(request.id, result.task);
      return result.task;
    } catch (error) {
      try {
        const accepted = await this.api.detail(request.id);
        this.finish(request.id, accepted.task);
        return accepted.task;
      } catch (readError) {
        if (error instanceof CreationApiError && readError instanceof CreationApiError && readError.status === 404)
          this.finish(request.id);
      }
      throw error;
    }
  }
}
