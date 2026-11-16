import { createHash } from "node:crypto";
export interface SearchConnection {
  id: string;
  kind: "elasticsearch" | "milvus" | "ollama" | "openai";
  url: string;
  username?: string;
  passwordFile?: string;
  apiKeyFile?: string;
  caFile?: string;
  model?: string;
  dimensions?: number;
  prefix?: string;
}
export interface KnowledgeConnection {
  id: string;
  vectors: string;
  embeddings: string;
}
export const connectionFingerprint = (connection: SearchConnection) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        kind: connection.kind,
        url: connection.url,
        model: connection.model,
        dimensions: connection.dimensions,
        prefix: connection.prefix,
      }),
    )
    .digest("hex");
