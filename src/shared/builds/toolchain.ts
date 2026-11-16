import { BUILD_ENGINES } from "./engines.js";

/** The stock Hexo toolchain has one version registry for site scaffolds and optional theme presets. */
const packages = Object.freeze({
  hexo: BUILD_ENGINES.hexo,
  "hexo-renderer-ejs": "2.0.0",
  "hexo-renderer-marked": "7.0.1",
  "hexo-renderer-stylus": "3.0.1",
  "hexo-generator-index": "4.0.0",
  cheerio: "1.2.0",
  "hexo-util": "4.0.0",
  "hexo-generator-feed": "4.0.0",
  "hexo-generator-sitemap": "3.0.1",
  "hexo-generator-archive": "2.0.0",
  "hexo-generator-category": "2.0.0",
  "hexo-generator-tag": "2.0.0",
});
const select = (names: readonly (keyof typeof packages)[]) =>
  Object.freeze(Object.fromEntries(names.map((name) => [name, packages[name]])));
export const HEXO_STYLUS_VERSION = packages["hexo-renderer-stylus"];

export const HEXO_RUNTIME_DEPENDENCIES = select([
  "hexo",
  "hexo-renderer-ejs",
  "hexo-renderer-marked",
  "hexo-renderer-stylus",
  "hexo-generator-index",
  "hexo-generator-archive",
  "hexo-generator-category",
  "hexo-generator-tag",
]);
/** Private worker images may provide additional exactly declared theme dependencies. */
export const DEFAULT_THEME_DEPENDENCIES = select([
  "cheerio",
  "hexo-util",
  "hexo-generator-feed",
  "hexo-generator-sitemap",
  "hexo-generator-archive",
  "hexo-generator-category",
  "hexo-generator-tag",
]);
