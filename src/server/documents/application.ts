import type { MetadataStore } from "../../shared/async-value.js";
import type { DocumentRevision } from "../../shared/documents/contracts.js";
import type { SiteThemeCatalog } from "../../shared/presentation/themes.js";
import type {
  AwaitableOperations,
  DocumentApplicationPort,
  DocumentAssetOperations,
  DocumentCommands,
  DocumentLanguageOperations,
  DocumentProfileOperations,
  DocumentQueries,
} from "./application-port.js";
import { text } from "./validation.js";

type DocumentOperations = AwaitableOperations<
  Pick<DocumentQueries, "space" | "listSpaces" | "detail" | "listDocuments"> &
    Omit<DocumentCommands, "importImages">
> & {
  themes: MetadataStore<SiteThemeCatalog>;
  sources: { inspect: DocumentQueries["inspectSource"] };
  ingestion: { importImages: DocumentCommands["importImages"] };
  documents: AwaitableOperations<{
    revision(id: string, revision: string): DocumentRevision;
    revisions(id: string): Omit<DocumentRevision, "content">[];
  }>;
};

/** Adapts existing native transactions without moving asynchronous work into SQLite callbacks. */
export function documentApplication(
  source: DocumentOperations,
  assets: AwaitableOperations<DocumentAssetOperations>,
  languages: AwaitableOperations<DocumentLanguageOperations>,
  profiles?: AwaitableOperations<DocumentProfileOperations>,
): DocumentApplicationPort {
  return {
    queries: {
      space: async (id) => source.space(id),
      listSpaces: async (id) => source.listSpaces(id),
      detail: async (id) => source.detail(id),
      listDocuments: async (space, search, offset) => source.listDocuments(space, search, offset),
      inspectSource: async (path) => source.sources.inspect(path),
      themes: async (engine) => ({
        themes: await source.themes.list(engine),
        defaults: {
          hexo: `${(await source.themes.resolve("default", "hexo")).id}@${(await source.themes.resolve("default", "hexo")).version}`,
          docusaurus: `${(await source.themes.resolve("default", "docusaurus")).id}@${(await source.themes.resolve("default", "docusaurus")).version}`,
        },
      }),
      history: async (id, revision) => {
        await source.detail(id);
        return revision === undefined
          ? { revisions: await source.documents.revisions(id) }
          : { revision: await source.documents.revision(id, text(revision, 128)) };
      },
    },
    commands: {
      createSpace: async (value) => source.createSpace(value),
      updateTheme: async (id, value) => source.updateTheme(id, value),
      importSource: async (id) => source.importSource(id),
      importImages: async (id, revision) => source.ingestion.importImages(id, revision),
      createDocument: async (value) => source.createDocument(value),
      saveDocument: async (id, value) => source.saveDocument(id, value),
    },
    assets: {
      list: async (id) => assets.list(id),
      upload: async (id, name, bytes) => assets.upload(id, name, bytes),
      content: async (id) => assets.content(id),
    },
    languages: {
      list: async (id) => languages.list(id),
      link: async (id, other) => languages.link(id, other),
      unlink: async (id) => languages.unlink(id),
    },
    ...(profiles
      ? {
          profiles: {
            get: async (id) => profiles.get(id),
            save: async (id, value, version) => profiles.save(id, value, version),
            options: async (id) => profiles.options(id),
            inspect: async (id, locale, files, webp) => profiles.inspect(id, locale, files, webp),
          },
        }
      : {}),
  };
}
