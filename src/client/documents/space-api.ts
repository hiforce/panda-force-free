import { documentApi } from "./api.js";

/** Configuration dialogs do not own document editing, storage selection or engine execution. */
export type DocumentSpaceApi = Pick<
  typeof documentApi,
  | "sourceProfile"
  | "sourceOptions"
  | "inspectSourceProfile"
  | "saveSourceProfile"
  | "themes"
  | "setTheme"
  | "spaces"
  | "createSpace"
  | "inspect"
>;

export const legacyDocumentSpaces: DocumentSpaceApi = documentApi;
