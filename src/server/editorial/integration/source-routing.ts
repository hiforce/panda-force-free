import type { EditorialSources } from "../ports.js";

/** Stored source scope fixes the backend. Missing or inaccessible file sources never invoke the legacy adapter. */
export function routeEditorialSources(legacy: EditorialSources, files: EditorialSources): EditorialSources {
  const source = (project?: string) => (project === undefined ? legacy : files);
  return {
    authorize: (id, project) => source(project).authorize(id, project),
    current: (id, project) => source(project).current(id, project),
    revision: (id, revision, project) => source(project).revision(id, revision, project),
    apply: (intent, body, completion) => source(intent.source.projectId).apply(intent, body, completion),
    applied: (intent, body) => source(intent.source.projectId).applied(intent, body),
  };
}
