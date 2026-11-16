/** One inventory for compilation, CDN validation and release checks. */
export const CLIENT_ENTRYPOINTS = {
  "i18n.js": "i18n.js",
  "http-client.js": "http-client.js",
  "auth-bootstrap.js": "auth-bootstrap.js",
  "panda-brand.js": "panda-brand.js",
  "app.js": "app.bundle.js",
  "file-preview.js": "file-preview.bundle.js",
  "terminal-runtime.js": "terminal-runtime.bundle.js",
  "settings-pages/runtime.ts": "settings-pages.bundle.js",
  "database/maintenance.ts": "database-maintenance.bundle.js",
  "knowledge/runtime.ts": "knowledge.bundle.js",
  "creative/assets-panel.ts": "creative-assets.bundle.js",
  "creative/workspaces-runtime.ts": "content-workspace.bundle.js",
  "templates/details-runtime.ts": "template-details.bundle.js",
  "templates/settings-runtime.ts": "template-settings.bundle.js",
  "templates/authoring-runtime.ts": "writing-skill.bundle.js",
  "creation/controller.ts": "document-creation.bundle.js",
  "gadget/document-runtime.ts": "gadget-document.bundle.js",
  "documents/code-block/reader-runtime.ts": "document-code-runtime.bundle.js",
  "documents/rich-runtime.ts": "document-rich-runtime.bundle.js",
} as const;

export const CLIENT_BUNDLES = Object.values(CLIENT_ENTRYPOINTS).map((name) => "/" + name);
