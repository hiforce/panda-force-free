import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { SearchError, type SearchDocument } from "../../../shared/search/contracts.js";
import type { IndexReference, SearchAnalyzer, SearchCandidate, TextIndexProvider, IndexAuditResult } from "../ports.js";
import { IndexIntegrityError } from "../integrity.js";
import { LOCAL_INDEX_FINGERPRINT, canRetireLocalIndex } from "./local-snapshot.js";
import type { IndexBuildProgress } from "../progress.js";
/** The built-in index owns a separate process, keeping tokenization, ranking and snapshots off the HTTP event loop. */
export class LocalTextIndex implements TextIndexProvider {
  readonly id = "local" as const;
  private child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private sequence = 0;
  private stopped = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: IndexBuildProgress }
  >();
  constructor(
    private root: string,
    private entry: string,
  ) {}
  fingerprint() {
    return LOCAL_INDEX_FINGERPRINT;
  }
  canRetire = canRetireLocalIndex;
  private start() {
    if (this.stopped) throw new SearchError("unavailable", 503);
    if (this.child) return this.child;
    const child = Bun.spawn([process.execPath, this.entry, this.root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.child = child;
    const lines = async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line),
              request = this.pending.get(message.id);
            if (!request) continue;
            if (message.progress) {
              const { completed, total } = message.progress;
              if (
                Number.isSafeInteger(completed) &&
                Number.isSafeInteger(total) &&
                completed >= 0 &&
                completed <= total
              )
                request.progress?.(completed, total);
              continue;
            }
            this.pending.delete(message.id);
            if (
              message.integrity === "missing" ||
              message.integrity === "corrupt" ||
              message.integrity === "unverified"
            )
              request.reject(new IndexIntegrityError(message.integrity));
            else if (message.error) request.reject(new SearchError(message.error, 503));
            else request.resolve(message.result);
          } catch {
            child.kill();
          }
        }
        if (buffer.length > 16 * 1024 * 1024) {
          child.kill();
          break;
        }
      }
    };
    void lines().catch(() => child.kill());
    void (async () => {
      for await (const chunk of child.stderr) {
        void chunk;
      }
    })().catch(() => {});
    void child.exited.then(() => {
      if (this.child === child) this.child = null;
      for (const request of this.pending.values()) request.reject(new SearchError("unavailable", 503));
      this.pending.clear();
    });
    return child;
  }
  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    progress?: IndexBuildProgress,
  ): Promise<T> {
    if (signal?.aborted) throw new SearchError("unavailable", 503);
    if (this.pending.size >= 16) throw new SearchError("limit", 429);
    const child = this.start(),
      id = ++this.sequence;
    let cancel: () => void = () => {},
      cancelled = false,
      settled = false,
      grace: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      settled = true;
      clearTimeout(grace);
      this.pending.delete(id);
    };
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        progress,
        resolve: (value) => {
          release();
          if (!cancelled) resolve(value as T);
        },
        reject: (error) => {
          release();
          if (!cancelled) reject(error);
        },
      });
      cancel = () => {
        if (settled || cancelled) return;
        cancelled = true;
        try {
          void Promise.resolve(child.stdin.write(JSON.stringify({ id, method: "cancel" }) + "\n")).catch(() =>
            child.kill(),
          );
        } catch {
          child.kill();
        }
        // Keep the worker admission slot until acknowledgement or child exit, even after the caller stops waiting.
        grace = setTimeout(() => {
          if (this.pending.has(id) && this.child === child) child.kill();
        }, 2000);
        reject(new SearchError("unavailable", 503));
      };
    });
    const timer = setTimeout(cancel, method === "build" ? 120000 : method === "audit" ? 60000 : 15000);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      if (cancelled) return await result;
      await child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      return await result;
    } catch (error) {
      cancel();
      await result.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (!cancelled) release();
    }
  }
  health() {
    return this.call<boolean>("health", {});
  }
  build(
    name: string,
    documents: SearchDocument[],
    analyzer: SearchAnalyzer,
    signal: AbortSignal,
    progress?: IndexBuildProgress,
  ) {
    return this.call<IndexReference>("build", { name, documents, analyzer: analyzer.descriptor }, signal, progress);
  }
  query(index: IndexReference, query: string, analyzer: SearchAnalyzer, limit: number, signal: AbortSignal) {
    return this.call<SearchCandidate[]>("query", { index, query, analyzer: analyzer.descriptor, limit }, signal);
  }
  drop(index: IndexReference) {
    return this.call<void>("drop", { index });
  }
  audit(index: IndexReference, analyzer: SearchAnalyzer, signal: AbortSignal) {
    return this.call<IndexAuditResult>("audit", { index, analyzer: analyzer.descriptor }, signal);
  }
  project(document: SearchDocument, analyzer: SearchAnalyzer, signal: AbortSignal) {
    return this.call<{ title: string; text: string; version: string }>(
      "project",
      { document, analyzer: analyzer.descriptor },
      signal,
    );
  }
  async close() {
    this.stopped = true;
    const child = this.child;
    if (child) {
      child.kill();
      await child.exited;
    }
  }
}
export const generationName = (scope: string, generation: string) =>
  createHash("sha256")
    .update(scope + ":" + generation)
    .digest("hex");
