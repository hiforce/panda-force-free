import { SearchError } from "../../../shared/search/contracts.js";
import { createSearchFeature } from "./feature.js";
import { searchRoutes, type SearchApi } from "./routes.js";
/** Optional search cannot prevent authentication, document reading or saving from starting. */
export async function createOptionalSearchFeature(options: Parameters<typeof createSearchFeature>[0]) {
  try {
    return await createSearchFeature(options);
  } catch (error) {
    if (options.storage) throw error;
    options.report(error);
    const unavailable = async (): Promise<never> => {
      throw new SearchError("unavailable", 503);
    };
    const api: SearchApi = {
      catalog: unavailable,
      previousSettings: unavailable,
      query: unavailable,
      status: unavailable,
      audit: unavailable,
      configure: unavailable,
      retry: unavailable,
      preview: unavailable,
      manual: unavailable,
      saveSource: unavailable,
      activate: unavailable,
      health: unavailable,
      vectorStorage: unavailable,
      checkVectorStorage: unavailable,
      addConnection: unavailable,
      addKnowledge: unavailable,
      review: unavailable,
      install: unavailable,
      export: unavailable,
    };
    return {
      query: unavailable,
      status: unavailable,
      routes: searchRoutes(api),
      start() {},
      changed: async () => {},
      close: async () => {},
    };
  }
}
