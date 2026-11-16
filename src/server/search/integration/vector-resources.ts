import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import { IndexResourceLifecycle } from "../resources/lifecycle.js";
import type { IndexResourceRegistry } from "../resources/contracts.js";
import { MilvusStorage } from "../providers/milvus-storage.js";
import { milvusResourceStorage } from "../providers/milvus-inventory.js";
import type { SearchHttp } from "../providers/http.js";
import type { VectorSealStore } from "../providers/vector-seal.js";
export function vectorResourceOwner(
  http: SearchHttp,
  instance: string,
  registry: MetadataStore<IndexResourceRegistry>,
  seals: VectorSealStore,
  report: (error: unknown) => void,
) {
  return new IndexResourceLifecycle(
    registry,
    milvusResourceStorage(new MilvusStorage(http, instance)),
    (name) => seals.drop({ name, provider: "milvus" }),
    report,
  );
}
