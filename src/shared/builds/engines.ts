/** Engine identity is independent of job payloads, presentation catalogs and deployment adapters. */
export const BUILD_PROTOCOL = 1;
export const BUILD_ENGINES = { hexo: "8.1.1", docusaurus: "3.10.2" } as const;
export type BuildEngine = keyof typeof BUILD_ENGINES;
