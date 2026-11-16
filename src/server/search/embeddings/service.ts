import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { SEARCH_LIMITS, SearchError, type SearchScope } from "../../../shared/search/contracts.js";
import type { SearchEmbeddingProvider } from "../ports.js";
import { float32Vector } from "../providers/vector-rows.js";
import { EmbeddingBudget } from "./budget.js";
import { EmbeddingCache } from "./cache.js";
import { openEmbeddingCacheDatabase } from "./cache-database.js";
import { openEmbeddingDatabase } from "./database.js";
import type { EmbeddingPolicy } from "./policy.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Shared admission surrounds raw inference. Cache reuse never replaces content authorization or current-source hydration. */
export class SearchEmbeddingService {
  private db: Database | null = null;
  private closing = new AbortController();
  private operations = new Set<Promise<unknown>>();
  constructor(
    private database: string,
    private root: string,
    private instance: string,
    private policy: EmbeddingPolicy,
    private report: (error: unknown) => void,
    private now = () => Date.now(),
    private budgetFactory?: (policy: EmbeddingPolicy, now: () => number) => MetadataStore<EmbeddingBudget>,
  ) {}
  provider(raw: SearchEmbeddingProvider, connection: string, scope?: SearchScope): SearchEmbeddingProvider {
    return {
      dimensions: raw.dimensions,
      fingerprint: () => raw.fingerprint(),
      health: () => raw.health(),
      embed: (texts, signal, purpose = "document") => {
        if (!scope || this.closing.signal.aborted) return Promise.reject(new SearchError("configuration", 503));
        const operation = this.embed(
          raw,
          connection,
          scope,
          texts,
          purpose,
          AbortSignal.any([signal, this.closing.signal]),
        );
        const tracked = operation.finally(() => this.operations.delete(tracked));
        this.operations.add(tracked);
        return tracked;
      },
    };
  }
  async usageAsync(owner: string) {
    return this.budgetFactory ? this.budgetFactory(this.policy, this.now).usage(owner) : this.usage(owner);
  }
  usage(owner: string) {
    if (this.budgetFactory) throw new SearchError("configuration", 503);
    if (this.db) return new EmbeddingBudget(this.db, this.policy, this.now).usage(owner);
    if (existsSync(this.database)) {
      const db = new Database(this.database, { readonly: true });
      try {
        const version = db
          .query<
            {
              user_version: number;
            },
            []
          >("PRAGMA user_version")
          .get()!.user_version;
        if (version > 1) throw new SearchError("unavailable", 503);
        if (version === 1) return new EmbeddingBudget(db, this.policy, this.now).usage(owner);
      } finally {
        db.close();
      }
    }
    return {
      calls: 0,
      characters: 0,
      callLimit: this.policy.ownerCallsPerDay,
      characterLimit: this.policy.ownerCharactersPerDay,
      resetsAt: (Math.floor(this.now() / 86400000) + 1) * 86400000,
    };
  }
  private async embed(
    raw: SearchEmbeddingProvider,
    connection: string,
    scope: SearchScope,
    texts: string[],
    purpose: "document" | "query",
    signal: AbortSignal,
  ) {
    const operation = new AbortController();
    signal = AbortSignal.any([signal, operation.signal]);
    signal.throwIfAborted();
    if (
      !["document", "query"].includes(purpose) ||
      !texts.length ||
      texts.length > 16 ||
      (purpose === "query" && texts.length !== 1) ||
      texts.some(
        (text) =>
          typeof text !== "string" ||
          !text.length ||
          text.length > (purpose === "query" ? SEARCH_LIMITS.query : SEARCH_LIMITS.chunkCharacters * 2),
      )
    )
      throw new SearchError("invalidInput");
    const db = (this.db ??= this.budgetFactory
        ? openEmbeddingCacheDatabase(this.database)
        : openEmbeddingDatabase(this.database)),
      budget = this.budgetFactory?.(this.policy, this.now) ?? new EmbeddingBudget(db, this.policy, this.now),
      cache = new EmbeddingCache(
        db,
        this.root,
        this.policy,
        this.now,
        this.budgetFactory ? (namespace, token) => budget.heartbeat(namespace, token) : undefined,
      ),
      model = hash([raw.fingerprint(), connection]),
      namespace = hash(["embedding-cache-v1", this.instance, scope.owner, scope.project, model, purpose]),
      inputs = new Map(texts.map((text) => [hash([namespace, text]), text])),
      values = new Map<string, number[]>(),
      token = randomUUID();
    const read = async () => {
      for (const key of inputs.keys()) {
        signal.throwIfAborted();
        const found = await cache.get(key, namespace, raw.dimensions);
        if (found) values.set(key, found);
      }
    };
    await read();
    const output = () => {
      signal.throwIfAborted();
      return texts.map((text) => [...values.get(hash([namespace, text]))!]);
    };
    if (values.size === inputs.size) return output();
    let locked = false,
      call: string | null = null,
      ambiguous = false;
    const heartbeat = setInterval(async () => {
      if (!locked) return;
      try {
        if (!(await budget.heartbeat(namespace, token)) || (call && !(await budget.heartbeatCall(call)))) {
          operation.abort();
          this.report(new SearchError("conflict", 409));
        }
      } catch {
        operation.abort();
        this.report(new SearchError("unavailable", 503));
      }
    }, 20000);
    heartbeat.unref();
    try {
      while (!locked) {
        signal.throwIfAborted();
        await budget.checkCooldown(model);
        locked = await budget.lock(namespace, token);
        if (!locked) await delay(100, undefined, { signal });
      }
      await read();
      const missing = [...inputs].filter(([key]) => !values.has(key));
      if (!missing.length) return output();
      const characters = missing.reduce((count, [, text]) => count + Array.from(text).length, 0);
      const reservation = await budget.admit(model, scope.owner, characters);
      call = reservation;
      let vectors: number[][];
      try {
        const response = await raw.embed(
          missing.map(([, text]) => text),
          signal,
          purpose,
        );
        if (!(await budget.heartbeat(namespace, token)) || !(await budget.heartbeatCall(reservation))) {
          operation.abort();
          throw new SearchError("conflict", 409);
        }
        if (!Array.isArray(response) || response.length !== missing.length) throw new SearchError("configuration", 503);
        try {
          vectors = response.map((vector) => float32Vector(vector, raw.dimensions));
        } catch {
          throw new SearchError("configuration", 503);
        }
        await budget.complete(reservation, model, false, false);
        call = null;
      } catch (error) {
        ambiguous = signal.aborted || !(error instanceof SearchError) || error.code === "unavailable";
        await budget.complete(reservation, model, true, ambiguous);
        call = null;
        throw error;
      }
      signal.throwIfAborted();
      for (const [index, [key]] of missing.entries()) {
        const vector = vectors[index]!;
        values.set(key, vector);
        try {
          await cache.put(key, namespace, token, vector, purpose, signal);
        } catch {
          if (!signal.aborted) this.report(new SearchError("unavailable", 503));
        }
      }
      if (!(await budget.heartbeat(namespace, token))) {
        operation.abort();
        throw new SearchError("conflict", 409);
      }
      signal.throwIfAborted();
      return output();
    } finally {
      clearInterval(heartbeat);
      if (locked && !ambiguous) await budget.unlock(namespace, token);
    }
  }
  async close() {
    this.closing.abort();
    await Promise.allSettled([...this.operations]);
    this.db?.close();
    this.db = null;
  }
}
