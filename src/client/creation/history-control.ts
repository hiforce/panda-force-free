import { confirmAction } from "../confirmation-dialog.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { creationApiFor, CreationApiError } from "./api.js";
import type { ActivityTask } from "./activity-model.js";

type Scope = ActivityTask["scope"];
interface PendingClear {
  requests: { scope: Scope; id: string; taskId?: string; before?: number; done?: boolean; failed?: boolean }[];
}
/** A frozen clear request can be resumed after a lost acknowledgement without clearing later work. */
export class CreationHistoryControl {
  private pending: PendingClear | null;
  private busy = false;
  private disposed = false;
  private feedback: "clearingHistory" | "historyCleared" | "clearHistoryUncertain" | "clearHistoryFailed" | null = null;
  private readonly key: string;
  constructor(
    identity: string,
    private readonly changed: () => void,
    private readonly cleared: (scope: Scope, taskId?: string) => void,
    private readonly boundary: () => number,
  ) {
    this.key = STORAGE_KEYS.creationSnapshotFor(identity, "history-clear");
    const saved = storage.getSessionJson(this.key, null);
    this.pending =
      saved &&
      Array.isArray(saved.requests) &&
      saved.requests.length > 0 &&
      saved.requests.length <= 2 &&
      saved.requests.every(
        (r: any) =>
          ["application", "personal"].includes(r.scope) &&
          typeof r.id === "string" &&
          /^[a-f0-9-]{36}$/.test(r.id) &&
          (r.taskId === undefined || typeof r.taskId === "string") &&
          (r.before === undefined || (Number.isSafeInteger(r.before) && r.before >= 0)),
      )
        ? saved
        : null;
    if (this.pending) this.feedback = "clearHistoryUncertain";
  }
  get blocked() {
    return this.busy || Boolean(this.pending);
  }
  get waiting() {
    return this.busy;
  }
  get resuming() {
    return Boolean(this.pending);
  }
  get error() {
    return this.feedback === "clearHistoryUncertain" || this.feedback === "clearHistoryFailed";
  }
  get notice() {
    return this.feedback ? (`creation.${this.feedback}` as const) : null;
  }
  dispose() {
    this.disposed = true;
  }
  private save() {
    if (this.pending) storage.setSessionJson(this.key, this.pending);
    else storage.removeSession(this.key);
  }
  async clear(task?: { id: string; scope: Scope }, returnFocus?: () => Element | null) {
    if (this.busy || this.disposed || (this.pending && task)) return;
    if (!this.pending) {
      const accepted = await confirmAction({
        title: task ? "creation.clearRecordTitle" : "creation.clearHistoryTitle",
        message: task ? "creation.clearRecordDescription" : "creation.clearHistoryDescription",
        confirmText: "creation.clearHistoryConfirm",
        cancelText: "common.cancel",
        returnFocus,
      });
      if (!accepted || this.disposed) return;
      const before = this.boundary();
      this.pending = {
        requests: task
          ? [{ scope: task.scope, id: crypto.randomUUID(), taskId: task.id, before }]
          : (["application", "personal"] as const).map((scope) => ({ scope, id: crypto.randomUUID(), before })),
      };
      this.save();
    }
    const focused = document.activeElement;
    this.busy = true;
    this.feedback = "clearingHistory";
    this.changed();
    try {
      const results = await Promise.allSettled(
        this.pending.requests
          .filter((r) => !r.done)
          .map(async (request) => {
            try {
              await creationApiFor(request.scope === "personal" ? "personal" : "").clearHistory({
                id: request.id,
                ...(request.taskId ? { taskId: request.taskId } : {}),
                ...(request.before === undefined ? {} : { before: request.before }),
              });
            } catch (error) {
              if (!(error instanceof CreationApiError) || ![400, 401, 403, 404, 409].includes(error.status))
                throw error;
              request.done = true;
              request.failed = true;
              this.save();
              return;
            }
            request.done = true;
            this.save();
            this.cleared(request.scope, request.taskId);
          }),
      );
      if (results.some((result) => result.status === "rejected")) this.feedback = "clearHistoryUncertain";
      else {
        this.feedback = this.pending.requests.some((request) => request.failed)
          ? "clearHistoryFailed"
          : "historyCleared";
        this.pending = null;
        this.save();
      }
    } finally {
      this.busy = false;
      this.changed();
      if (!this.disposed && (document.activeElement === focused || document.activeElement === document.body)) {
        const target = returnFocus?.();
        if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
      }
    }
  }
}
