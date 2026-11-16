declare const PANDA_LOCALE_VERSION: string;
declare module "*/app.bundle.js";
declare module "*/terminal-runtime.bundle.js" {
  export const Terminal: typeof import("@xterm/xterm").Terminal;
  export const FitAddon: typeof import("@xterm/addon-fit").FitAddon;
}
declare module "*/file-preview.bundle.js" {
  export const createFilePreview: typeof import("./file-preview.js").createFilePreview;
}
declare module "*/document-rich-runtime.bundle.js" {
  export const createRichDocumentEditor: typeof import("./documents/rich-runtime.js").createRichDocumentEditor;
}
declare module "*/document-rich-runtime.bundle.js?retry=1" {
  export const createRichDocumentEditor: typeof import("./documents/rich-runtime.js").createRichDocumentEditor;
}
declare module "*/document-code-runtime.bundle.js" {
  export const createCodeReader: typeof import("./documents/code-block/reader-runtime.js").createCodeReader;
}
declare module "*/document-code-runtime.bundle.js?retry=1" {
  export const createCodeReader: typeof import("./documents/code-block/reader-runtime.js").createCodeReader;
}
declare module "*/document-creation.bundle.js" {
  export const DocumentCreationPanel: typeof import("./creation/controller.js").DocumentCreationPanel;
}
declare module "*/document-creation.bundle.js?retry=1" {
  export const DocumentCreationPanel: typeof import("./creation/controller.js").DocumentCreationPanel;
}
declare module "*/template-settings.bundle.js" {
  export const prepareWritingEditor: typeof import("./documents/rich-loader.js").warmRichEditor;
  export const createTemplateCommands: typeof import("./templates/commands.js").createTemplateCommands;
  export const previewSkill: typeof import("./templates/skill-preview.js").previewSkill;
  export const previewPortable: typeof import("./templates/portable-preview.js").portableTemplatePreview;
}
declare module "*/template-settings.bundle.js?retry=1" {
  export const prepareWritingEditor: typeof import("./documents/rich-loader.js").warmRichEditor;
  export const createTemplateCommands: typeof import("./templates/commands.js").createTemplateCommands;
  export const previewSkill: typeof import("./templates/skill-preview.js").previewSkill;
  export const previewPortable: typeof import("./templates/portable-preview.js").portableTemplatePreview;
}

declare module "*/writing-skill.bundle.js" {
  export const createTemplateAuthoring: typeof import("./templates/authoring/controller.js").createTemplateAuthoring;
  export const prepareWritingEditor: typeof import("./documents/rich-loader.js").warmRichEditor;
}
declare module "*/writing-skill.bundle.js?retry=1" {
  export const createTemplateAuthoring: typeof import("./templates/authoring/controller.js").createTemplateAuthoring;
  export const prepareWritingEditor: typeof import("./documents/rich-loader.js").warmRichEditor;
}

declare module "*/template-details.bundle.js" {
  export const templateDetailAdapters: typeof import("./templates/detail-adapters.js").templateDetailAdapters;
  export const createTemplateVersions: typeof import("./templates/versions.js").createTemplateVersions;
  export const createTemplateScreenshotPanel: typeof import("./template-previews/panel.js").createTemplateScreenshotPanel;
  export const templatePreviewSupported: typeof import("./template-previews/builtins.js").templatePreviewSupported;
}
declare module "*/template-details.bundle.js?retry=1" {
  export const templateDetailAdapters: typeof import("./templates/detail-adapters.js").templateDetailAdapters;
  export const createTemplateVersions: typeof import("./templates/versions.js").createTemplateVersions;
  export const createTemplateScreenshotPanel: typeof import("./template-previews/panel.js").createTemplateScreenshotPanel;
  export const templatePreviewSupported: typeof import("./template-previews/builtins.js").templatePreviewSupported;
}

declare module "*/settings-pages.bundle.js" {
  export const settingsPageFactories: typeof import("./settings-pages/runtime.js").settingsPageFactories;
}
declare module "*/settings-pages.bundle.js?retry=1" {
  export const settingsPageFactories: typeof import("./settings-pages/runtime.js").settingsPageFactories;
}
declare module "*/knowledge.bundle.js" {
  export const KnowledgePanel: typeof import("./knowledge/controller.js").KnowledgePanel;
  export const KnowledgeRecordView: typeof import("./knowledge/record.js").KnowledgeRecordView;
}
declare module "*/knowledge.bundle.js?retry=1" {
  export const KnowledgePanel: typeof import("./knowledge/controller.js").KnowledgePanel;
  export const KnowledgeRecordView: typeof import("./knowledge/record.js").KnowledgeRecordView;
}
declare module "*/creative-assets.bundle.js" {
  export const CreativeAssetsPanel: typeof import("./creative/assets-panel.js").CreativeAssetsPanel;
}
declare module "*/creative-assets.bundle.js?retry=1" {
  export const CreativeAssetsPanel: typeof import("./creative/assets-panel.js").CreativeAssetsPanel;
}

declare module "*/content-workspace.bundle.js" {
  export const createContentWorkspace: typeof import("./creative/workspaces-runtime.js").createContentWorkspace;
}
declare module "*/content-workspace.bundle.js?retry=1" {
  export const createContentWorkspace: typeof import("./creative/workspaces-runtime.js").createContentWorkspace;
}

declare module "*/gadget-document.bundle.js" {
  export const createDocumentComposer: typeof import("../gadget/system/composer/document.js").createDocumentComposer;
}
declare module "*/gadget-document.bundle.js?retry=1" {
  export const createDocumentComposer: typeof import("../gadget/system/composer/document.js").createDocumentComposer;
}
