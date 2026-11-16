import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import { VectorSealStore } from "../providers/vector-seal.js";
import type { SearchSourceDefinition, SearchScope } from "../../../shared/search/contracts.js";
import { SearchError } from "../../../shared/search/contracts.js";
import type { SearchRuntime } from "../indexer.js";
import { generationName, LocalTextIndex } from "../providers/local.js";
import { ElasticsearchIndex } from "../providers/elasticsearch.js";
import { MilvusIndex } from "../providers/milvus.js";
import { SearchEmbeddings } from "../providers/embeddings.js";
import type { SearchConnections } from "./connections.js";
import type { SearchSourceRegistry } from "../storage/registry.js";
import type { AnalyzerStore } from "../analyzers/store.js";
import type { SearchEmbeddingService } from "../embeddings/service.js";
import type { IndexResourceRegistry } from "../resources/contracts.js";
import { vectorResourceOwner } from "./vector-resources.js";
export function searchRuntime(
  sources: MetadataStore<SearchSourceRegistry>,
  connections: MetadataStore<SearchConnections>,
  analyzers: MetadataStore<AnalyzerStore>,
  local: LocalTextIndex,
  instance: string,
  seals: VectorSealStore,
  embeddings: SearchEmbeddingService,
  resources: MetadataStore<IndexResourceRegistry>,
  report: (error: unknown) => void,
): MetadataStore<SearchRuntime> & {
  available(source: SearchSourceDefinition): Promise<void>;
} {
  const text = async (source: SearchSourceDefinition) => {
    if (source.kind === "local") return local;
    if (!source.connection || (await connections.get(source.connection)).kind !== "elasticsearch")
      throw new SearchError("configuration", 409);
    return new ElasticsearchIndex(await connections.http(source.connection), instance, local);
  };
  const vectors = async (source: SearchSourceDefinition, scope?: SearchScope) => {
    if (!source.knowledge) return null;
    const k = (await connections.knowledge()).find((k) => k.id === source.knowledge);
    if (!k) throw new SearchError("configuration", 409);
    return new MilvusIndex(
      await connections.http(k.vectors),
      embeddings.provider(new SearchEmbeddings(await connections.http(k.embeddings)), k.embeddings, scope),
      instance,
      seals,
      vectorResourceOwner(await connections.http(k.vectors), instance, resources, seals, report),
    );
  };
  return {
    source: async (id) => await sources.get(id),
    text,
    vectors,
    analyzer: async (ref) => await analyzers.resolve(ref),
    generation: generationName,
    async available(source) {
      if (source.kind === "local" && source.connection) throw new SearchError("invalidInput");
      await text(source);
      await vectors(source);
    },
  };
}
