import type { IncomingMessage } from "node:http";
import { sharedWorkspaceAllowed } from "../auth/users/access.js";
import type { LocalAccounts } from "../auth/users/service.js";
import type { createContentAccess } from "../content-access/integration/feature.js";
import type { ProjectSnapshot } from "../../shared/engine/types.js";
import { ProjectError } from "./catalog.js";

type MemberRequest = { req: IncomingMessage };

export type ProjectMembers = ReturnType<typeof createProjectMembers>;

export function createProjectMembers(
  accounts: LocalAccounts,
  access: ReturnType<typeof createContentAccess>,
  owner: (context: MemberRequest) => string,
) {
  function selected(input: unknown, directory: Awaited<ReturnType<LocalAccounts["projectDirectory"]>>) {
    if (!Array.isArray(input) || input.length > 100 || !input.every((id) => typeof id === "string"))
      throw new ProjectError(400, "projects.errorProjectMembers");
    const eligible = new Map(directory.map(({ id, owner }) => [id, owner]));
    const result = [...new Set(input)].map((id) => eligible.get(id));
    if (result.some((id) => !id)) throw new ProjectError(400, "projects.errorProjectMembers");
    return result as string[];
  }
  return {
    async isCreator(context: MemberRequest, project: string) {
      const actor = owner(context);
      return (await access.service.projectMembership(actor, project))?.owner === actor;
    },
    async snapshot(context: MemberRequest, snapshot: ProjectSnapshot) {
      const sharedWorkspace = sharedWorkspaceAllowed(context.req);
      const view = await access.service.viewProjects(owner(context), snapshot.projects, sharedWorkspace);
      const permitted = new Map(view.projects.map((project) => [project.id, project]));
      const projects = await Promise.all(
        snapshot.projects
          .filter(({ id }) => permitted.has(id))
          .map(async ({ workspace, ...project }) => {
            const visible = permitted.get(project.id)!;
            const canManageMembers =
              visible.canManageMembers ||
              (!sharedWorkspace &&
                visible.role === "contributor" &&
                (await access.service.projectMembership(view.owner, project.id))?.owner === view.owner);
            return {
              ...project,
              ...(workspace && sharedWorkspace ? { workspace } : {}),
              ...(canManageMembers ? { canManageMembers: true } : {}),
            };
          }),
      );
      return {
        ...snapshot,
        projects,
        assignments: sharedWorkspace ? snapshot.assignments.filter(({ projectId }) => permitted.has(projectId)) : [],
      };
    },
    async select(input: unknown) {
      if (input === undefined || (Array.isArray(input) && !input.length)) return [];
      return selected(input, await accounts.projectDirectory());
    },
    async options(context: MemberRequest, project?: string) {
      const actor = owner(context);
      const current = project ? await access.service.projectMembership(actor, project) : null;
      if (project && !current) return { editable: false, revision: null, members: [] };
      const granted = new Set(current?.grants.filter(({ role }) => role !== "blocked").map(({ owner }) => owner));
      const creator = project ? current?.owner : actor;
      granted.add(creator ?? actor);
      const members = (await accounts.projectDirectory()).map(({ id, username, owner }) => ({
        id,
        username,
        selected: granted.has(owner),
        creator: owner === creator,
      }));
      members.sort((a, b) => Number(b.creator) - Number(a.creator) || a.username.localeCompare(b.username));
      return {
        editable: true,
        revision: current?.revision ?? null,
        members,
        ...(current?.legacy ? { legacy: true, chooseOwner: !current.owner } : {}),
      };
    },
    async update(context: MemberRequest, project: string, input: unknown, revision: unknown, ownerId?: unknown) {
      if (!Number.isSafeInteger(revision)) throw new ProjectError(400, "projects.errorProjectMembers");
      const actor = owner(context);
      const current = await access.service.projectMembership(actor, project);
      if (!current) throw new ProjectError(404, "projects.errorProjectNotFound");
      const directory = await accounts.projectDirectory();
      const members = selected(input, directory);
      const chosenOwner = ownerId === undefined ? undefined : selected([ownerId], directory)[0];
      const enabled = new Set(directory.map(({ owner }) => owner));
      // A temporarily disabled member keeps the previously selected membership.
      for (const grant of current.grants)
        if (grant.role !== "blocked" && !enabled.has(grant.owner)) members.push(grant.owner);
      await access.service.replaceProjectMembers(actor, project, members, Number(revision), chosenOwner);
    },
  };
}
