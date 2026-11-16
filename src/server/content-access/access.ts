import {
  ContentAccessError,
  contentAccessOwner,
  contentAccessProject,
  type ContentAccessPolicy,
  type ContentAccessAction,
  type ContentAccessMemberships,
} from "./contracts.js";

/** The authenticated owner and current membership are checked independently of a client's narrower API-key grants. */
export class ContentScopeAccess {
  constructor(
    private readonly policy: ContentAccessPolicy,
    private readonly store: ContentAccessMemberships,
    private readonly localAdministrator: () => string | null,
  ) {}
  administrator(owner: string) {
    contentAccessOwner(owner);
    return this.localAdministrator() === owner || this.policy.administrators.has(owner);
  }
  async role(owner: string, project: string) {
    contentAccessOwner(owner);
    contentAccessProject(project);
    if (project === "personal" || this.administrator(owner)) return "contributor" as const;
    const role = await this.store.role(owner, project);
    return role === "blocked" ? null : (role ?? (this.policy.mode === "shared" ? "contributor" : null));
  }
  async require(owner: string, project: string, action: ContentAccessAction = "read") {
    const role = await this.role(owner, project);
    if (!role || (action === "contribute" && role !== "contributor")) throw new ContentAccessError("notFound");
  }
  async view(owner: string, projects: readonly { id: string; name: string }[]) {
    contentAccessOwner(owner);
    for (const project of projects) contentAccessProject(project.id);
    const permitted: { id: string; name: string; role: "reader" | "contributor" }[] = [];
    const administrator = this.administrator(owner),
      roles =
        !administrator && this.store.roles
          ? await this.store.roles(
              owner,
              projects.map((p) => p.id),
            )
          : null;
    for (const project of projects) {
      const role =
        administrator || project.id === "personal"
          ? "contributor"
          : roles
            ? (roles.get(project.id) ?? (this.policy.mode === "shared" ? "contributor" : null))
            : await this.role(owner, project.id);
      if (role && role !== "blocked") permitted.push({ id: project.id, name: project.name, role });
    }
    return {
      owner: contentAccessOwner(owner),
      administrator: this.administrator(owner),
      mode: this.policy.mode,
      personal: true,
      projects: permitted,
    };
  }
}
