import { createHash } from "node:crypto";
import { stableJson } from "../../shared/stable-json.js";

export const knowledgeValueDigest = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");
