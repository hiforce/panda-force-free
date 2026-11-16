import manifest from "./builtins.json";
/** Fixed product files only; native/private preview images are authorized API resources. */
export const TEMPLATE_PREVIEW_ASSETS = [
  ...new Set(manifest.entries.flatMap((entry) => Object.values(entry.images).map((image) => image.path))),
];
export const CREATION_STYLES = ["/creation.css", "/template-previews.css"];
