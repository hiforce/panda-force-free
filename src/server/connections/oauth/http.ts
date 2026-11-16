import type { OAuthJsonTransport } from "./ports.js";
import { OAuthError } from "./errors.js";

/** One bounded request; callers must persist dispatch before exchanging or rotating a token. */
export class OAuthHttp implements OAuthJsonTransport {
  constructor(
    private send: typeof fetch = fetch,
    private timeoutMs = 15000,
  ) {}
  async request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
      response = await this.send(url, { ...init, redirect: "error", signal: controller.signal });
      if (response.status === 429) throw new OAuthError("authorizationRateLimited");
      if ([400, 401, 403].includes(response.status)) throw new OAuthError("authorizationRejected");
      if (!response.ok) throw new OAuthError("authorizationUnavailable");
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body)
        throw new OAuthError("invalidOAuthResponse");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 65536) throw new OAuthError("invalidOAuthResponse");
        chunks.push(part.value);
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new OAuthError("invalidOAuthResponse");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthError("invalidOAuthResponse");
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError("authorizationUnavailable");
    } finally {
      controller.abort();
      clearTimeout(timer);
      // Cancel without waiting on a potentially stalled transport teardown.
      void reader?.cancel().catch(() => {});
      if (!reader) void response?.body?.cancel().catch(() => {});
    }
  }
}
