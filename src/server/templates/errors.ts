export class TemplateCatalogError extends Error {
  constructor(readonly code: "invalidQuery" | "catalogChanged" | "unavailable") {
    super(code);
    this.name = "TemplateCatalogError";
  }
}
