export const MATERIAL_TEXT_LIMITS = Object.freeze({
  inputBytes: 25 * 1024 * 1024,
  textBytes: 4 * 1024 * 1024,
  pages: 300,
  sheets: 64,
  cells: 100000,
  parts: 4096,
});
export const MATERIAL_TEXT_VERSION = "panda.material-text/1-unpdf-2.2.1";
export type MaterialTextFailure = "unsupported" | "unreadable" | "empty" | "encrypted" | "tooLarge" | "busy";
export class MaterialTextError extends Error {
  constructor(readonly code: MaterialTextFailure) {
    super(code);
    this.name = "MaterialTextError";
  }
}
export interface MaterialText {
  text: string;
  sections: number;
}
