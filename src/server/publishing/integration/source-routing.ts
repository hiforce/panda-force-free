import type { PublicationSources, PublicationAssets } from "../content/source-port.js";

type PublishingSource = { sources: PublicationSources; assets: PublicationAssets };
/** Explicit persisted scope determines storage. Inaccessible file content never falls back to legacy IDs. */
export function routePublicationSources(legacy: PublishingSource, files: PublishingSource): PublishingSource {
  const selected = (project?: string) => (project === undefined ? legacy : files);
  return {
    sources: {
      authorize: (id, project) => selected(project).sources.authorize(id, project),
      current: (id, project) => selected(project).sources.current(id, project),
      revision: (id, revision, project) => selected(project).sources.revision(id, revision, project),
    },
    assets: { content: (id, asset, project) => selected(project).assets.content(id, asset, project) },
  };
}
