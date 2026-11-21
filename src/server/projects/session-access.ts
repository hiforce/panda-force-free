import { harnessId } from "../../shared/harness/presentation.js";
import type { SessionSummary, ProjectSnapshot } from "../../shared/engine/types.js";
import type { ProjectDirectoryPolicy } from "./directory-policy.js";
import { ProjectError } from "./catalog.js";

export interface ManagedProjectSessions<Context> {
  get(context: Context, id: string): Promise<SessionSummary>;
  list(context: Context): Promise<SessionSummary[]>;
}

/** Project associations resolve public identities through their owning conversation service. */
export class ProjectSessionAccess<Context> {
  constructor(
    private readonly options: {
      policy: ProjectDirectoryPolicy;
      native(id: string): Promise<SessionSummary>;
      managed?: ManagedProjectSessions<Context>;
    },
  ) {}
  async get(context: Context, id: string): Promise<SessionSummary> {
    const internal = harnessId(id);
    const session = internal ? await this.options.managed?.get(context, internal) : await this.options.native(id);
    if (!session || !this.options.policy.allowsPath(session.cwd))
      throw new ProjectError(404, "projects.errorSessionNotFoundRefreshTheSessionListAndTryAgain");
    return session;
  }
  async managed(context: Context) {
    return ((await this.options.managed?.list(context)) ?? []).filter(
      (session) => !!harnessId(session.id) && this.options.policy.allowsPath(session.cwd),
    );
  }
  async snapshot(context: Context, value: ProjectSnapshot): Promise<ProjectSnapshot> {
    const { reloadRequired: _reload, ...native } = this.options.policy.snapshot(value);
    if (!value.assignments.some((session) => harnessId(session.id))) return native;
    const owned = new Map((await this.managed(context)).map((session) => [session.id, session]));
    return {
      ...native,
      assignments: [
        ...native.assignments,
        ...value.assignments.filter((session) => harnessId(session.id) && owned.has(session.id)),
      ],
    };
  }
}
