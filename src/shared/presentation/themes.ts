import type { BuildEngine } from "../builds/engines.js";
import type { DocumentEngine } from "../documents/contracts.js";
import type { PresentationLabel } from "./labels.js";

import type { SiteThemeProfile } from "./theme-profile.js";
export type { SiteThemeProfile } from "./theme-profile.js";
export interface SiteThemeDescriptor extends PresentationLabel {
  id: string;
  version: string;
  engine: BuildEngine;
  kind: "builtin" | "installed";
  profile: SiteThemeProfile | null;
  package?: { id: string; version: string; digest: string };
}
/** Catalog consumers select versioned references; they never select a container image or command. */
export interface SiteThemeCatalog {
  list(engine: DocumentEngine): SiteThemeDescriptor[];
  validate(reference: string, engine: DocumentEngine): string;
  resolve(reference: string, engine: BuildEngine): SiteThemeDescriptor;
}
const definitions: readonly SiteThemeDescriptor[] = [
  {
    id: "panda.reader",
    version: "1.0.0",
    nameId: "documents.themeReader",
    descriptionId: "documents.themeReaderHint",
    engine: "hexo",
    kind: "builtin",
    profile: { layout: "reader", font: "sans", accent: "#4c50c6", width: 880, density: "comfortable" },
  },
  {
    id: "panda.journal",
    version: "1.0.0",
    nameId: "documents.themeJournal",
    descriptionId: "documents.themeJournalHint",
    engine: "hexo",
    kind: "builtin",
    profile: { layout: "journal", font: "serif", accent: "#845738", width: 760, density: "comfortable" },
  },
  {
    id: "panda.handbook",
    version: "1.0.0",
    nameId: "documents.themeHandbook",
    descriptionId: "documents.themeHandbookHint",
    engine: "docusaurus",
    kind: "builtin",
    profile: { layout: "handbook", font: "sans", accent: "#5155d9", width: 1120, density: "comfortable" },
  },
  {
    id: "panda.reference",
    version: "1.0.0",
    nameId: "documents.themeReference",
    descriptionId: "documents.themeReferenceHint",
    engine: "docusaurus",
    kind: "builtin",
    profile: { layout: "reference", font: "sans", accent: "#28636f", width: 1280, density: "compact" },
  },
];
export const themeReference = (theme: Pick<SiteThemeDescriptor, "id" | "version">) => `${theme.id}@${theme.version}`;
export class ThemeSelectionError extends Error {
  constructor(readonly code: "unknownTheme" | "incompatibleTheme") {
    super(code);
  }
}
/** Return independent values: a UI or adapter cannot mutate the installed catalog for another request. */
export const builtinSiteThemes: SiteThemeCatalog = {
  list(engine) {
    return definitions
      .filter((item) => engine === "markdown" || item.engine === engine)
      .map((item) => structuredClone(item));
  },
  validate(reference, engine) {
    if (reference === "default") return reference;
    const selected = definitions.find((item) => themeReference(item) === reference);
    if (!selected) throw new ThemeSelectionError("unknownTheme");
    if (engine !== "markdown" && selected.engine !== engine) throw new ThemeSelectionError("incompatibleTheme");
    return reference;
  },
  resolve(reference, engine) {
    const selected =
      reference === "default"
        ? definitions.find((item) => item.id === (engine === "hexo" ? "panda.reader" : "panda.handbook"))
        : definitions.find((item) => themeReference(item) === reference);
    if (!selected) throw new ThemeSelectionError("unknownTheme");
    if (selected.engine !== engine) throw new ThemeSelectionError("incompatibleTheme");
    return structuredClone(selected);
  },
};
