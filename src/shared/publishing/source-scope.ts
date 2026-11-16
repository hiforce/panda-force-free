/** Optional provenance is omitted for legacy snapshots so their serialized identity stays unchanged. */
export interface ContentSourceScope {
  projectId?: string;
  commit?: string;
}
export function contentSourceScope(source: ContentSourceScope): ContentSourceScope {
  return {
    ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
    ...(source.commit === undefined ? {} : { commit: source.commit }),
  };
}
