import { SourceError } from "../../shared/packages/sources/contracts.js";

export interface SourceHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}
export interface SourceHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}
export interface SourceHttpPort {
  get(request: SourceHttpRequest): Promise<SourceHttpResponse>;
}
export type SourceFetch = (url: string, options: RequestInit) => Promise<Response>;

/** Acquisition follows no redirects and stores no ambient cookies, credentials or remote error bodies. */
export class BoundedSourceHttp implements SourceHttpPort {
  constructor(
    private fetcher: SourceFetch = fetch,
    private timeoutMs = 30000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SourceError("invalidSource");
  }
  async get(request: SourceHttpRequest): Promise<SourceHttpResponse> {
    const url = request.url,
      headers = { ...request.headers },
      maxBytes = request.maxBytes,
      caller = request.signal,
      timeout = AbortSignal.timeout(this.timeoutMs),
      signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SourceError("invalidSource");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      complete = false;
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
      });
      const responseHeaders: Record<string, string> = {};
      for (const key of ["location", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"])
        if (response.headers.has(key)) responseHeaders[key] = response.headers.get(key)!;
      reader = response.body?.getReader();
      if (response.status !== 200)
        return { status: response.status, headers: Object.freeze(responseHeaders), bytes: new Uint8Array() };
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
        throw new SourceError("sourceTooLarge");
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > maxBytes) throw new SourceError("sourceTooLarge");
          chunks.push(new Uint8Array(chunk.value));
        }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      complete = true;
      return { status: response.status, headers: Object.freeze(responseHeaders), bytes };
    } catch (error) {
      if (caller?.aborted) throw new SourceError("sourceCancelled");
      if (timeout.aborted) throw new SourceError("sourceTimedOut");
      throw error instanceof SourceError ? error : new SourceError("sourceUnavailable");
    } finally {
      if (reader) {
        if (!complete) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
}
