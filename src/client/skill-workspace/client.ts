import type {
  SkillWorkspaceCommand,
  SkillWorkspaceMutation,
  SkillWorkspaceSnapshot,
} from "../../shared/skill-workspace.js";
import { templateJson } from "../templates/api.js";
import { PluginApiError } from "../plugins/api.js";

async function timed<T>(read: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await read(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
/** Pending writes retain their identity after an uncertain response, including when a dialog closes. */
export class SkillWorkspaceClient {
  snapshot: SkillWorkspaceSnapshot | null = null;
  busy = false;
  loading = false;
  error: unknown = null;
  pending: SkillWorkspaceMutation | null = null;
  private listeners = new Set<() => void>();
  private read: Promise<void> | null = null;
  private write: Promise<void> | null = null;
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  private accept(value: SkillWorkspaceSnapshot) {
    if (!this.snapshot || value.revision >= this.snapshot.revision) this.snapshot = value;
  }
  load(): Promise<void> {
    if (this.read) return this.read;
    this.loading = true;
    this.notify();
    this.read = timed((signal) =>
      templateJson<SkillWorkspaceSnapshot>("/api/skill-workspace", "GET", undefined, signal),
    )
      .then(
        (value) => {
          this.accept(value);
          if (!this.pending) this.error = null;
        },
        (error) => {
          this.error = error;
        },
      )
      .finally(() => {
        this.loading = false;
        this.read = null;
        this.notify();
      });
    return this.read;
  }
  change(command: SkillWorkspaceCommand) {
    if (this.write && JSON.stringify(command) === JSON.stringify(this.pending?.command)) return this.write;
    if (this.pending || !this.snapshot)
      return Promise.reject(new PluginApiError(409, { messageId: "skillWorkspace.confirmPending" }));
    this.pending = {
      operationId: crypto.randomUUID(),
      expectedRevision: this.snapshot.revision,
      command: structuredClone(command),
    };
    return this.retry();
  }
  retry(): Promise<void> {
    if (this.write) return this.write;
    if (!this.pending) return this.load();
    const input = this.pending;
    this.busy = true;
    this.error = null;
    this.notify();
    this.write = timed((signal) =>
      templateJson<SkillWorkspaceSnapshot>("/api/skill-workspace/commands", "POST", input, signal),
    )
      .then(
        (value) => {
          this.accept(value);
          this.pending = null;
        },
        async (error) => {
          if (error instanceof PluginApiError && error.status < 500) {
            this.pending = null;
            if (error.status === 409) await this.load();
          }
          this.error = error;
          throw error;
        },
      )
      .finally(() => {
        this.busy = false;
        this.write = null;
        this.notify();
      });
    return this.write;
  }
}
