import { SourceError } from "../../../shared/packages/sources/contracts.js";
import type { GitHubRepository } from "../../../shared/packages/sources/github.js";
import type { SourceHttpPort, SourceHttpResponse } from "../source-http.js";
import { awaitSourceResult } from "../source-deadline.js";

export interface GitHubSourceCredentials {
  token(connectionId: string, signal?: AbortSignal): Promise<string | null>;
}
export const gitSha = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new SourceError("invalidSource");
  return value;
};
export function githubObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SourceError("invalidSource");
  return value as Record<string, unknown>;
}
/** Every read uses a constructed API path and the current explicitly selected credential. */
export class GitHubSourceClient {
  private budget: { remaining: number; resetAt: number | null } | null = null;
  constructor(
    private http: SourceHttpPort,
    readonly repository: GitHubRepository,
    private connectionId?: string,
    private credentials?: GitHubSourceCredentials,
  ) {}
  private async headers(accept: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "PandaForce-source-import",
    };
    if (this.connectionId) {
      let token: string | null | undefined;
      try {
        const pending = this.credentials?.token(this.connectionId, signal) ?? Promise.resolve(null);
        token = signal ? await awaitSourceResult(pending, signal) : await pending;
      } catch {
        if (signal?.aborted) throw new SourceError("sourceCancelled");
        throw new SourceError("sourceAccessDenied");
      }
      if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new SourceError("sourceAccessDenied");
      headers.Authorization = "Bearer " + token;
    }
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    return headers;
  }
  async authorize(signal?: AbortSignal): Promise<void> {
    await this.headers("application/vnd.github+json", signal);
  }
  private async response(path: string, accept: string, maxBytes: number, signal?: AbortSignal) {
    const headers = await this.headers(accept, signal);
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    let response: SourceHttpResponse;
    try {
      response = await this.http.get({
        url: `https://api.github.com/repos/${this.repository.owner}/${this.repository.name}${path}`,
        headers,
        maxBytes,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw error instanceof SourceError ? error : new SourceError("sourceUnavailable");
    }
    const remaining = response.headers["x-ratelimit-remaining"],
      reset = response.headers["x-ratelimit-reset"],
      resetAt = reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : null;
    this.budget =
      remaining && /^\d+$/.test(remaining) && Number.isSafeInteger(Number(remaining))
        ? { remaining: Number(remaining), resetAt: resetAt !== null && Number.isSafeInteger(resetAt) ? resetAt : null }
        : null;
    if (response.status === 429 || (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0"))
      throw new SourceError("sourceRateLimited");
    if ([401, 403].includes(response.status)) throw new SourceError("sourceAccessDenied");
    if (response.bytes.byteLength > maxBytes) throw new SourceError("sourceTooLarge");
    return response;
  }
  /** Server headers give a preflight estimate, not a reservation against other clients sharing the account. */
  requireRequests(count: number) {
    if (!Number.isSafeInteger(count) || count < 0) throw new SourceError("invalidSource");
    if (
      this.budget &&
      (this.budget.resetAt === null || this.budget.resetAt > Date.now()) &&
      count > this.budget.remaining
    )
      throw new SourceError("sourceRateLimited");
  }
  private async request(path: string, accept: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.response(path, accept, maxBytes, signal);
    if (response.status !== 200) throw new SourceError("sourceUnavailable");
    return new Uint8Array(response.bytes);
  }
  async archiveLocation(commit: string, signal?: AbortSignal): Promise<string> {
    const response = await this.response("/zipball/" + gitSha(commit), "application/vnd.github+json", 1024, signal),
      location = response.headers.location;
    if (response.status !== 302 || !location || location.length > 8192) throw new SourceError("sourceUnavailable");
    return location;
  }
  bytes(path: string, maxBytes: number, signal?: AbortSignal) {
    return this.request(path, "application/vnd.github.raw+json", maxBytes, signal);
  }
  async json(path: string, maxBytes: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const bytes = await this.request(path, "application/vnd.github+json", maxBytes, signal);
    try {
      return githubObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      throw error instanceof SourceError ? error : new SourceError("invalidSource");
    }
  }
  async resolve(ref: string, signal?: AbortSignal): Promise<string> {
    const bytes = await this.request("/commits/" + encodeURIComponent(ref), "application/vnd.github.sha", 1024, signal);
    return gitSha(new TextDecoder().decode(bytes).trim());
  }
}
