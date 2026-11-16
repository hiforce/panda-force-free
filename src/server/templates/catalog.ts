import { skillCategoryPredicate, type SkillCategoryFilter } from "../../shared/skill-workspace.js";
import { galleryTemplates } from "./gallery.js";
import { contentSha256 } from "../../shared/packages/digest.js";
import type { TemplateCatalogPage, TemplateRegistry } from "../../shared/templates/catalog.js";
import { managedTemplateKey, templateLineageKey } from "../../shared/templates/catalog.js";
import type { TemplateCatalogSource } from "./ports.js";
import { TemplateCatalogError } from "./errors.js";
import { templateInSection, templateSections, type TemplateSection } from "../../shared/templates/sections.js";
import { templateInDomain, type TemplateDomain } from "../../shared/templates/domain.js";

export interface TemplateCatalogQuery {
  view?: "gallery" | "versions";
  section?: TemplateSection;
  domain?: TemplateDomain;
  engine?: string;
  format?: string;
  registry?: TemplateRegistry;
  type?: string;
  category?: string;
  state?: "all" | "enabled" | "disabled" | "removed";
  search?: string;
  cursor?: string;
  limit?: number;
  lineages?: readonly string[];
  categoryFilter?: SkillCategoryFilter;
  personalRevision?: number;
  order?: "identity" | "purpose";
}
/** This read model composes native facts; it grants no installation or execution authority. */
export class TemplateCatalog {
  constructor(private sources: readonly TemplateCatalogSource[]) {
    if (new Set(sources.map((source) => source.registry)).size !== sources.length)
      throw new TemplateCatalogError("unavailable");
  }
  async get(key: string, actor: string) {
    const matches = await this.getMany([key], actor);
    if (!matches[0]) throw new TemplateCatalogError("invalidQuery");
    return matches[0];
  }
  async getMany(keys: readonly string[], actor: string) {
    if (!keys.length) return [];
    const wanted = new Set(keys);
    const registries = new Set(keys.map((key) => key.split(":")[0]));
    const sources = this.sources.filter((source) => registries.has(source.registry));
    const values = await Promise.all(sources.map((source) => source.read(actor)));
    if (values.some((value, index) => value.registry !== sources[index]!.registry))
      throw new TemplateCatalogError("unavailable");
    const matches = new Map<string, import("../../shared/templates/catalog.js").ManagedTemplate>();
    for (const item of values.flatMap((value) => value.templates))
      if (wanted.has(item.key)) {
        if (matches.has(item.key)) throw new TemplateCatalogError("unavailable");
        matches.set(item.key, item);
      }
    return keys.map((key) => {
      const item = matches.get(key);
      return item && item.key === managedTemplateKey(item.reference) ? structuredClone(item) : null;
    });
  }
  async list(query: TemplateCatalogQuery = {}, actor?: string): Promise<TemplateCatalogPage> {
    const {
      registry,
      view = "versions",
      section,
      domain,
      engine = "",
      format = "",
      type = "",
      category = "",
      state = "all",
      search = "",
      cursor,
      limit = 40,
      lineages,
      categoryFilter,
      personalRevision,
      order = "identity",
    } = query;
    if (
      !["gallery", "versions"].includes(view) ||
      !["identity", "purpose"].includes(order) ||
      (section !== undefined && !templateSections.includes(section)) ||
      (domain !== undefined && !["skills", "publishing"].includes(domain)) ||
      (engine !== "" && !["hexo", "docusaurus"].includes(engine)) ||
      typeof format !== "string" ||
      format.length > 64 ||
      /[\p{Cc}\p{Cf}]/u.test(format) ||
      (registry !== undefined &&
        !["builtin", "portable", "presentation", "skills", "native", "native-slides"].includes(registry)) ||
      typeof type !== "string" ||
      type.length > 100 ||
      typeof category !== "string" ||
      category.length > 64 ||
      typeof search !== "string" ||
      search.length > 200 ||
      /[\p{Cc}\p{Cf}]/u.test(type + category + search) ||
      !["all", "enabled", "disabled", "removed"].includes(state) ||
      (lineages !== undefined &&
        (lineages.length > 2000 || lineages.some((key) => typeof key !== "string" || key.length > 1400))) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new TemplateCatalogError("invalidQuery");
    const snapshots = await Promise.all(this.sources.map((source) => source.read(actor)));
    const revisions: TemplateCatalogPage["revisions"] = {};
    for (const [index, snapshot] of snapshots.entries()) {
      if (snapshot.registry !== this.sources[index]!.registry) throw new TemplateCatalogError("unavailable");
      revisions[snapshot.registry] = snapshot.revision;
    }
    const binding = await contentSha256(
      JSON.stringify({
        revisions,
        view,
        section,
        domain,
        engine,
        format,
        registry,
        type,
        category,
        state,
        search,
        limit,
        lineages,
        categoryFilter,
        personalRevision,
        order,
        ...(actor === undefined ? {} : { actor }),
      }),
    );
    let offset = 0;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== "string" || cursor.length > 1000 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) throw Error();
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          !parsed ||
          Object.keys(parsed).sort().join(",") !== "binding,offset" ||
          !Number.isSafeInteger(parsed.offset) ||
          parsed.offset < 0
        )
          throw Error();
        if (parsed.binding !== binding) throw new TemplateCatalogError("catalogChanged");
        offset = parsed.offset;
      } catch (error) {
        if (error instanceof TemplateCatalogError) throw error;
        throw new TemplateCatalogError("invalidQuery");
      }
    }
    const all = snapshots.flatMap((snapshot) => snapshot.templates);
    const keys = new Set<string>();
    for (const item of all) {
      if (item.key !== managedTemplateKey(item.reference) || keys.has(item.key))
        throw new TemplateCatalogError("unavailable");
      keys.add(item.key);
    }
    const needle = search.toLowerCase();
    const purposeOrder = new Map(
      all.map((item, index) => {
        const rank = templateSections.findIndex((section) => templateInSection(item, section));
        return [item.key, { rank: rank < 0 ? templateSections.length : rank, index }] as const;
      }),
    );
    const selectedLineages = lineages ? new Set(lineages) : null;
    const inCategory = categoryFilter && skillCategoryPredicate(categoryFilter);
    const candidates = view === "gallery" ? galleryTemplates(all, state === "removed") : all;
    const filtered = candidates
      .filter(
        (item) =>
          (!domain || templateInDomain(item, domain)) &&
          (!selectedLineages || selectedLineages.has(templateLineageKey(item.reference))) &&
          (!inCategory ||
            inCategory(templateLineageKey(item.reference), (section) => templateInSection(item, section))) &&
          (!registry || item.reference.registry === registry) &&
          (!section || templateInSection(item, section)) &&
          (!engine || item.compatibility.engines.some((value) => value === engine)) &&
          (!format ||
            item.compatibility.formats.some(
              // Threads are a Post composition; Article remains a separate publication type.
              (value) => value === format || (format === "x-post" && value === "x-thread"),
            )) &&
          (!type || item.templateType === type) &&
          (!category || item.categories.includes(category)) &&
          (state === "all"
            ? !item.state.removed
            : state === "removed"
              ? item.state.removed
              : !item.state.removed && item.state.enabled === (state === "enabled")) &&
          (!needle ||
            JSON.stringify({ label: item.label, reference: item.reference, publisher: item.publisher })
              .toLowerCase()
              .includes(needle)),
      )
      .sort((a, b) => {
        if (order === "purpose") {
          const difference = purposeOrder.get(a.key)!.rank - purposeOrder.get(b.key)!.rank;
          if (difference) return difference;
          return purposeOrder.get(a.key)!.index - purposeOrder.get(b.key)!.index;
        }
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
    if (offset > filtered.length) throw new TemplateCatalogError("invalidQuery");
    const templates = filtered.slice(offset, offset + limit);
    return structuredClone({
      revisions,
      templates,
      total: filtered.length,
      nextCursor:
        offset + limit < filtered.length
          ? Buffer.from(JSON.stringify({ binding, offset: offset + limit })).toString("base64url")
          : null,
    });
  }
}
