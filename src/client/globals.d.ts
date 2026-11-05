declare const PANDA_LOCALE_VERSION: string;
declare module "*/app.bundle.js";
declare module "*/terminal-runtime.bundle.js" {
  export const Terminal: typeof import("@xterm/xterm").Terminal;
  export const FitAddon: typeof import("@xterm/addon-fit").FitAddon;
}
declare module "*/file-preview.bundle.js" {
  export const createFilePreview: typeof import("./file-preview.js").createFilePreview;
}
