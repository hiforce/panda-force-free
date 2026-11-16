import type { AsyncSocialSources } from "../social/async-ports.js";
/** Native routing awaits relational references and never treats a Promise or a failed lookup as a default source. */
export function routeMySQLSocialSources(
  legacy: AsyncSocialSources,
  files: AsyncSocialSources,
  projectForVariant: (id: string) => string | undefined | Promise<string | undefined>,
): AsyncSocialSources {
  const selected = (project?: string) => (project === undefined ? legacy : files);
  return {
    capture: async (owner, id) => selected(await projectForVariant(id)).capture(owner, id),
    authorize: (owner, source, project, space) => selected(source.projectId).authorize(owner, source, project, space),
    space: (owner, space, project) => selected(project).space(owner, space, project),
    readImage: (owner, source, image) => selected(source.projectId).readImage(owner, source, image),
    article: (owner, source, preview, images) => selected(source.projectId).article(owner, source, preview, images),
  };
}
