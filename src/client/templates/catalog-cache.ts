import type { TemplateCatalogPage } from "../../shared/templates/catalog.js";

/** One manager owns this metadata-only cache; it is never shared across principals or persisted. */
export class TemplateCatalogCache {
  private entries = new Map<string, { expires: number; page: TemplateCatalogPage }>();
  constructor(private now = () => Date.now()) {}
  read(query: string) {
    const entry = this.entries.get(query);
    if (!entry) return null;
    if (entry.expires <= this.now()) {
      this.entries.delete(query);
      return null;
    }
    this.entries.delete(query);
    this.entries.set(query, entry);
    return structuredClone(entry.page);
  }
  write(query: string, page: TemplateCatalogPage) {
    this.entries.delete(query);
    this.entries.set(query, { expires: this.now() + 30000, page: structuredClone(page) });
    while (this.entries.size > 12) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() {
    this.entries.clear();
  }
}
