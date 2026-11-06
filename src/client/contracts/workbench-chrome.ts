import type { Translate } from "../../shared/i18n/messages.js";
import type { I18nRuntime } from "./platform.js";

export interface WorkbenchChromeOptions {
  t: Translate;
  i18n: I18nRuntime;
  openSearch: () => void;
  openSettings: (page: string) => void;
  readSidebar: () => boolean;
  setSidebar: (open: boolean, settings?: { temporary?: boolean }) => void;
  readDetails: () => boolean;
  setDetails: (open: boolean, settings?: { temporary?: boolean }) => void;
  hasSession: () => boolean;
  onError: (message: string) => void;
}

export type ReadingWidth = "comfortable" | "wide" | "fill";
export type ChromeMenu = "preferences" | "language" | "appearance" | "layout" | "profile";

export interface WorkbenchLayout {
  readWidth: () => ReadingWidth;
  setWidth: (value: string) => void;
  isFocused: () => boolean;
  setFocus: (focused: boolean) => void;
  setPanel: (panel: "navigation" | "details", open: boolean) => void;
  reconcileViewport: () => void;
}
