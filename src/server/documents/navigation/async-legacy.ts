import type { MetadataStore } from "../../../shared/async-value.js";
import type { ProjectDocumentNavigation } from "./service.js";
import type { DocumentNavigationPort } from "./port.js";

/** This explicit bridge keeps the live legacy composition stable until every content consumer participates in cutover. */
export function asyncLegacyNavigation(
  service: MetadataStore<
    Pick<ProjectDocumentNavigation, "tree" | "trashPage" | "create" | "move" | "rename" | "trash" | "restore">
  >,
): DocumentNavigationPort {
  return {
    tree: async (projectId) => service.tree(projectId),
    trashPage: async (projectId, cursor) => service.trashPage(projectId, cursor),
    create: async (actor, input) => service.create(actor, input),
    move: async (actor, input) => service.move(actor, input),
    rename: async (actor, input) => service.rename(actor, input),
    trash: async (actor, input) => service.trash(actor, input),
    restore: async (actor, input) => service.restore(actor, input),
  };
}
