import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isRecord } from "../../shared/records.js";
import { harnessId } from "../../shared/harness/presentation.js";
import { ProjectError } from "./catalog.js";
import type { ProjectSnapshot, ProjectVisibility } from "../../shared/engine/types.js";

/** Browser visibility is independent of engine sandbox permissions and never relocates native history. */
export class ProjectDirectoryPolicy {
  private protectedSession: (id: string, session?: unknown) => boolean = () => false;
  protectSessions(predicate: (id: string, session?: unknown) => boolean) {
    this.protectedSession = predicate;
  }
  private readonly sessions = new Map<string, string>();
  private readonly approvals = new Set<string | number>();
  constructor(
    readonly root: string,
    readonly allowExternal: boolean,
  ) {}
  get browserScope(): string {
    return this.allowExternal ? "" : "projects-" + createHash("sha256").update(this.root).digest("hex");
  }
  allowsPath(path: unknown): boolean {
    if (this.allowExternal) return true;
    if (typeof path !== "string" || !isAbsolute(path)) return false;
    try {
      const root = realpathSync(this.root),
        current = realpathSync(resolve(path)),
        suffix = relative(root, current);
      return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix));
    } catch {
      return false;
    }
  }
  remember(value: unknown): boolean {
    if (isRecord(value) && typeof value.id === "string" && this.protectedSession(value.id, value)) return false;
    if (this.allowExternal) return true;
    if (!isRecord(value) || typeof value.id !== "string") return false;
    this.sessions.delete(value.id);
    if (!this.allowsPath(value.cwd)) return false;
    this.sessions.set(value.id, String(value.cwd));
    while (this.sessions.size > 10000) this.sessions.delete(this.sessions.keys().next().value!);
    return true;
  }
  async assertRequest(
    method: string,
    params: Record<string, unknown>,
    flags: Record<string, unknown>,
    getSession: (id: string) => Promise<unknown>,
  ): Promise<void> {
    if (typeof params.threadId === "string" && this.protectedSession(params.threadId))
      throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
    if (this.allowExternal) {
      if (typeof params.threadId === "string") {
        let session: unknown;
        try {
          session = await getSession(params.threadId);
        } catch {
          session = null;
        }
        if (this.protectedSession(params.threadId, session))
          throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
      }
      return;
    }
    if (method === "thread/start" && flags.pandaProjectId !== undefined) return;
    if (typeof params.threadId === "string") {
      let session: unknown;
      try {
        session = await getSession(params.threadId);
      } catch {
        session = null;
      }
      if (!this.remember(session))
        throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
    }
    if (params.cwd !== undefined && !this.allowsPath(params.cwd))
      throw new ProjectError(403, "projects.errorDirectoryOutsideRoot");
  }
  async list(method: string, value: unknown, getSession: (id: string) => Promise<unknown>): Promise<unknown> {
    if (["thread/list", "thread/loaded/list"].includes(method) && isRecord(value) && Array.isArray(value.data))
      value = {
        ...value,
        data: value.data.filter((entry) => {
          const id = typeof entry === "string" ? entry : isRecord(entry) ? entry.id : null;
          return typeof id !== "string" || !this.protectedSession(id, entry);
        }),
      };
    if (
      this.allowExternal ||
      !["thread/list", "thread/loaded/list"].includes(method) ||
      !isRecord(value) ||
      !Array.isArray(value.data)
    )
      return value;
    const data: unknown[] = [];
    for (const entry of value.data) {
      let session: unknown = entry;
      if (typeof entry === "string") {
        try {
          session = await getSession(entry);
        } catch {
          continue;
        }
      }
      if (this.remember(session)) data.push(entry);
    }
    return { ...value, data };
  }
  snapshot(value: ProjectSnapshot): ProjectSnapshot {
    const native = value.assignments.filter((session) => !harnessId(session.id));
    if (this.allowExternal)
      return native.length === value.assignments.length
        ? value
        : { ...value, assignments: native, reloadRequired: true };
    return {
      ...value,
      projects: value.projects.map((project) => {
        if (!project.workspace || this.allowsPath(project.workspace.path)) return project;
        const { workspace, ...safe } = project;
        void workspace;
        return safe;
      }),
      assignments: native.filter((session) => this.allowsPath(session.cwd)),
      ...(native.length !== value.assignments.length ? { reloadRequired: true } : {}),
    };
  }
  visibility(value: ProjectVisibility): ProjectVisibility {
    if (this.allowExternal) return value;
    return {
      ...value,
      hiddenProjects: Object.fromEntries(
        Object.entries(value.hiddenProjects).filter(([path]) => this.allowsPath(path)),
      ),
    };
  }
  envelope(input: unknown): boolean {
    if (isRecord(input) && isRecord(input.params)) {
      const params = input.params,
        thread = isRecord(params.thread) ? params.thread : null;
      const id = params.threadId ?? params.conversationId ?? thread?.id;
      if (typeof id === "string" && this.protectedSession(id, thread)) return false;
    }
    if (this.allowExternal) return true;
    if (!isRecord(input) || typeof input.method !== "string") return false;
    const params = isRecord(input.params) ? input.params : {};
    if (input.method === "serverRequest/resolved") {
      const id = params.requestId;
      if (typeof id !== "string" && typeof id !== "number") return false;
      return this.approvals.delete(id);
    }
    const thread = isRecord(params.thread) ? params.thread : null;
    if (thread) this.remember(thread);
    const id = params.threadId ?? params.conversationId ?? thread?.id;
    if (typeof id === "string") {
      if (!this.sessions.has(id)) return false;
      if (input.id !== undefined && (typeof input.id === "string" || typeof input.id === "number")) {
        this.approvals.add(input.id);
        while (this.approvals.size > 10000) this.approvals.delete(this.approvals.values().next().value!);
      }
      if (["thread/deleted", "thread/closed"].includes(input.method)) this.sessions.delete(id);
      return true;
    }
    if (input.id !== undefined || /^(?:thread|turn|item|goal|codex)\//.test(input.method)) return false;
    return true;
  }
  event(input: object): object | null {
    if (isRecord(input)) {
      if (typeof input.threadId === "string" && this.protectedSession(input.threadId)) return null;
      if (input.type === "engine/notification" && isRecord(input.payload) && !this.envelope(input.payload)) return null;
    }
    if (isRecord(input) && input.type === "project-catalog/changed")
      return { ...input, ...this.snapshot(input as unknown as ProjectSnapshot) };
    if (this.allowExternal || !isRecord(input)) return input;
    // The local goal reader emits outside the native notification pipeline.
    if (
      input.type === "engine/notification" &&
      isRecord(input.payload) &&
      input.payload.method === "goal/status/changed"
    ) {
      const params = input.payload.params;
      if (!isRecord(params) || typeof params.threadId !== "string" || !this.sessions.has(params.threadId)) return null;
    }
    if (typeof input.threadId === "string" && !this.sessions.has(input.threadId)) return null;
    if (input.type === "projects/visibility" && isRecord(input.hiddenProjects))
      return { ...input, ...this.visibility(input as unknown as ProjectVisibility) };
    return input;
  }
}
