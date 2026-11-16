import { SearchError } from "../../../shared/search/contracts.js";
import { searchRecord } from "../../../shared/search/validation.js";

export interface EmbeddingPolicy {
  concurrent: number;
  callsPerMinute: number;
  callsPerDay: number;
  ownerCallsPerDay: number;
  charactersPerDay: number;
  ownerCharactersPerDay: number;
  cacheBytes: number;
  cacheEntries: number;
  documentTtlHours: number;
  queryTtlMinutes: number;
  backoffSeconds: number;
}

export const DEFAULT_EMBEDDING_POLICY: Readonly<EmbeddingPolicy> = Object.freeze({
  concurrent: 2,
  callsPerMinute: 30,
  callsPerDay: 1000,
  ownerCallsPerDay: 500,
  charactersPerDay: 5000000,
  ownerCharactersPerDay: 2000000,
  cacheBytes: 256 * 1024 * 1024,
  cacheEntries: 50000,
  documentTtlHours: 720,
  queryTtlMinutes: 1440,
  backoffSeconds: 5,
});

/** Budgets count admitted calls and input characters, including ambiguous failures; they are not billing estimates. */
export function embeddingPolicy(value?: unknown): EmbeddingPolicy {
  let input: Record<string, unknown>;
  try {
    input = value === undefined ? {} : searchRecord(value, Object.keys(DEFAULT_EMBEDDING_POLICY));
  } catch {
    throw new SearchError("configuration", 503);
  }
  const policy = { ...DEFAULT_EMBEDDING_POLICY, ...input } as EmbeddingPolicy;
  const bounds: Record<keyof EmbeddingPolicy, [number, number]> = {
    concurrent: [1, 16],
    callsPerMinute: [1, 1000],
    callsPerDay: [1, 1000000],
    ownerCallsPerDay: [1, 1000000],
    charactersPerDay: [1, 1000000000],
    ownerCharactersPerDay: [1, 1000000000],
    cacheBytes: [1024 * 1024, 8 * 1024 * 1024 * 1024],
    cacheEntries: [1, 1000000],
    documentTtlHours: [1, 8760],
    queryTtlMinutes: [1, 10080],
    backoffSeconds: [1, 60],
  };
  for (const key of Object.keys(bounds) as (keyof EmbeddingPolicy)[])
    if (!Number.isSafeInteger(policy[key]) || policy[key] < bounds[key][0] || policy[key] > bounds[key][1])
      throw new SearchError("configuration", 503);
  if (policy.ownerCallsPerDay > policy.callsPerDay || policy.ownerCharactersPerDay > policy.charactersPerDay)
    throw new SearchError("configuration", 503);
  return policy;
}
