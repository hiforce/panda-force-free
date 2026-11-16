import type { KnowledgeContent } from "../tasks/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";

/** The composition root selects an authorized personal or project adapter; tasks never choose a filesystem path. */
export function routeKnowledgeContent(
  project: KnowledgeContent | ((owner: string) => Promise<KnowledgeContent>),
  personal: (owner: string) => Promise<KnowledgeContent>,
  authorizePersonal?: (owner: string) => Promise<void>,
  recover?: KnowledgeContent["recover"],
): KnowledgeContent {
  const source = (owner: string, id: string) =>
    id === "personal" ? personal(owner) : typeof project === "function" ? project(owner) : Promise.resolve(project);
  return {
    authorize: async (owner, id) =>
      id === "personal" && authorizePersonal
        ? authorizePersonal(owner)
        : (await source(owner, id)).authorize(owner, id),
    capture: async (owner, selection) => (await source(owner, selection.project)).capture(owner, selection),
    current: async (owner, input) => (await source(owner, input.scope.project)).current(owner, input),
    save: async (owner, input, record, assertAdmitted) =>
      (await source(owner, input.scope.project)).save(owner, input, record, assertAdmitted),
    recover: async (owner, input, record, missing) =>
      recover
        ? recover(owner, input, record, missing)
        : ((await source(owner, input.scope.project)).recover?.(owner, input, record, missing) ?? null),
    projection: async (owner, input, record, receipt) => {
      const content = await source(owner, input.scope.project);
      if (!content.projection) throw new KnowledgeTaskError("unavailable");
      return content.projection(owner, input, record, receipt);
    },
  };
}
