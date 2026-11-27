import type { Database } from "bun:sqlite";
import type { RouteContext } from "../../http/router.js";
import type { DocumentFileProjects } from "../../documents/files/projects.js";
import { DocumentError } from "../../documents/errors.js";
import { ContentScopeAccess } from "../access.js";
import { ContentAccessStore } from "../storage/grants.js";
import type { ContentAccessRepository } from "../storage/ports.js";
import {
  ContentAccessError,
  contentAccessOwner,
  contentAccessProject,
  type ContentAccessAction,
  type ContentAccessRole,
} from "../contracts.js";
import { contentAccessPolicy } from "./config.js";
import { contentAccessRoutes } from "./routes.js";

/** A single catalog owns grant transactions; project file leases serialize membership changes with content operations. */
export function createContentAccess(
  options: {
    db?: Database;
    store?: ContentAccessRepository;
    stateRoot: string;
    projects(): { id: string; name: string }[] | Promise<{ id: string; name: string }[]>;
    requireProject(project: string): unknown;
    requireLegacyProject?(project: string): unknown;
    documents: DocumentFileProjects;
    localAdministrator(): string | null;
    ownerAllowed(owner: string): boolean;
    owner(context: RouteContext): string;
    report(error: unknown): void;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  let store: ContentAccessRepository | null = null,
    sqliteStore: ContentAccessStore | null = null,
    access: ContentScopeAccess | null = null;
  try {
    if (options.store) store = options.store;
    else {
      if (!options.db) throw new ContentAccessError("unavailable");
      store = sqliteStore = new ContentAccessStore(options.db);
    }
    access = new ContentScopeAccess(contentAccessPolicy(options.stateRoot, env), store, options.localAdministrator);
  } catch (error) {
    options.report(error);
  }
  const identity = (owner: string) => {
    contentAccessOwner(owner);
    if (!options.ownerAllowed(owner)) throw new ContentAccessError("notFound");
  };
  const available = () => {
    if (!access || !store) throw new ContentAccessError("unavailable");
    return { access, store };
  };
  const administrator = (actor: string) => {
    identity(actor);
    const current = available();
    if (!current.access.administrator(actor)) throw new ContentAccessError("forbidden");
    return current;
  };
  const requireAccess = async (
    owner: string,
    project: string,
    action: ContentAccessAction = "read",
    legacy = false,
  ) => {
    try {
      identity(owner);
      contentAccessProject(project);
      if (project === "personal") return;
      await available().access.require(owner, project, action);
      if (legacy) {
        if (!options.requireLegacyProject) throw new DocumentError("notFound", 404);
        await options.requireLegacyProject(project);
      } else await options.requireProject(project);
    } catch (error) {
      if (error instanceof ContentAccessError)
        throw new DocumentError(
          error.code === "unavailable" ? "unavailable" : "notFound",
          error.code === "unavailable" ? 503 : 404,
        );
      throw error;
    }
  };
  const service = {
    async view(owner: string) {
      return service.viewProjects(owner, await options.projects());
    },
    async viewProjects(owner: string, projects: readonly { id: string; name: string }[], allowLegacy = false) {
      identity(owner);
      return available().access.view(owner, projects, allowLegacy);
    },
    async projectMembership(actor: string, project: string) {
      identity(actor);
      contentAccessProject(project);
      if (project === "personal") return null;
      const { store } = available();
      const registered = await store.projectOwner?.(project);
      if (registered)
        return registered === actor ? { ...(await store.grants(project)), owner: actor, legacy: false } : null;
      const creator = await store.legacyCreator?.(project);
      if (creator ? creator !== actor : actor !== options.localAdministrator()) return null;
      await options.requireProject(project);
      return { ...(await store.grants(project)), owner: creator ?? null, legacy: true };
    },
    async replaceProjectMembers(
      actor: string,
      project: string,
      members: string[],
      revision: number,
      chosenOwner?: string,
    ) {
      const current = await service.projectMembership(actor, project);
      if (!current) throw new ContentAccessError("notFound");
      if (current.revision !== revision) throw new ContentAccessError("conflict");
      if (current.owner ? chosenOwner && chosenOwner !== current.owner : !chosenOwner)
        throw new ContentAccessError("invalidInput");
      const owner = current.owner ?? chosenOwner!;
      identity(owner);
      members.forEach(identity);
      const { store } = available();
      if (!store.replaceMembers) throw new ContentAccessError("unavailable");
      const legacy = current.legacy ? { actor, allowUnverified: !current.owner } : undefined;
      const write = async () => {
        await store.replaceMembers!(owner, project, members, revision, Date.now(), legacy);
        return true;
      };
      const result = await options.documents.ifPresent(project, write);
      if (!result) await options.documents.initialize(project, (repository) => repository.coordinator.view(write));
    },
    async grants(actor: string, project: unknown) {
      const { store } = administrator(actor),
        id = contentAccessProject(project);
      if (id === "personal") throw new ContentAccessError("invalidInput");
      await options.requireProject(id);
      const [grants, owner] = await Promise.all([store.grants(id), store.projectOwner?.(id)]);
      return { ...grants, ...(owner ? { projectOwner: owner } : {}) };
    },
    async set(actor: string, value: unknown) {
      administrator(actor);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContentAccessError("invalidInput");
      const p = value as Record<string, unknown>;
      if (
        Object.keys(p).some((key) => !["project", "owner", "role", "revision"].includes(key)) ||
        Object.keys(p).length !== 4 ||
        !Number.isSafeInteger(p.revision) ||
        ![null, "reader", "contributor", "blocked"].includes(p.role as ContentAccessRole)
      )
        throw new ContentAccessError("invalidInput");
      const project = contentAccessProject(p.project),
        owner = contentAccessOwner(p.owner);
      if (project === "personal") throw new ContentAccessError("invalidInput");
      await options.requireProject(project);
      const write = () =>
        administrator(actor).store.set(
          actor,
          project,
          owner,
          p.role as ContentAccessRole | null,
          Number(p.revision),
          Date.now(),
        );
      if ((await available().store.revision()) !== Number(p.revision)) throw new ContentAccessError("conflict");
      const result = await options.documents.ifPresent(project, async () => write());
      // An explicit grant mutation may establish an empty owned repository to obtain the same cross-process lease as content writers.
      return (
        result ??
        options.documents.initialize(project, async (repository) => repository.coordinator.view(async () => write()))
      );
    },
  };
  return {
    /** Called only while reserving new project metadata in the catalog transaction. */
    reserveCreator(owner: string, project: string, members: readonly string[] = []): void {
      identity(owner);
      members.forEach(identity);
      contentAccessProject(project);
      if (!sqliteStore || !options.db?.inTransaction || project === "personal")
        throw new ContentAccessError("invalidInput");
      options.requireProject(project);
      sqliteStore.reserveCreator(owner, project, Date.now(), members);
    },
    async reserveCreatorAsync(owner: string, project: string, members: readonly string[] = []): Promise<void> {
      identity(owner);
      members.forEach(identity);
      contentAccessProject(project);
      if (!options.store?.reserveCreator) throw new ContentAccessError("unavailable");
      await options.requireProject(project);
      await options.store.reserveCreator(owner, project, Date.now(), members);
    },
    require: (owner: string, project: string, action: ContentAccessAction = "read") =>
      requireAccess(owner, project, action),
    requireLegacy: (owner: string, project: string, action: ContentAccessAction = "read") =>
      requireAccess(owner, project, action, true),
    service,
    routes: contentAccessRoutes(service, options),
  };
}
