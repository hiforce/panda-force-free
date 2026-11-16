import type { SocialSources } from "../social/ports.js";

/** Only a persisted variant/plan binding selects storage. Failed file reads never invoke a legacy source. */
export function routeSocialSources(
  legacy: SocialSources,
  files: SocialSources,
  projectForVariant: (id: string) => string | undefined,
): SocialSources {
  const selected = (project?: string) => (project === undefined ? legacy : files);
  return {
    capture: (owner, id) => selected(projectForVariant(id)).capture(owner, id),
    authorize: (owner, source, project, space) => selected(source.projectId).authorize(owner, source, project, space),
    space: (owner, space, project) => selected(project).space(owner, space, project),
    readImage: (owner, source, image) => selected(source.projectId).readImage(owner, source, image),
    article: (owner, source, preview, images) => selected(source.projectId).article(owner, source, preview, images),
  };
}
