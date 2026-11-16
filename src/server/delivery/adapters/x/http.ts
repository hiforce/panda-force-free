import { RemoteOperationError } from "../../workflows/errors.js";
import { X_POST_LOOKUP_FIELDS } from "./lookup-fields.js";

export interface XAccess {
  accessToken: string;
  accountId: string;
  guard(): void | Promise<void>;
}
export interface XJsonTransport {
  request(path: string, access: XAccess, body?: string, method?: "POST" | "GET"): Promise<Record<string, unknown>>;
}
/** Fixed-origin, bounded, single-dispatch transport. Never follow a redirect or retry a mutation. */
export class XPublicationHttp implements XJsonTransport {
  constructor(
    private send: typeof fetch = fetch,
    private timeoutMs = 20000,
  ) {}
  async request(
    path: string,
    access: XAccess,
    body?: string,
    method: "POST" | "GET" = "POST",
  ): Promise<Record<string, unknown>> {
    const valid =
      method === "GET"
        ? (/^\/2\/media\/upload\?media_id=[0-9]{1,19}&command=STATUS$/.test(path) ||
            (/^\/2\/tweets\/[0-9]{1,19}\?tweet\.fields=/.test(path) &&
              path.split("?tweet.fields=")[1] === X_POST_LOOKUP_FIELDS)) &&
          body === undefined
        : method === "POST" &&
          /^\/2\/(?:tweets|articles\/draft|articles\/[0-9]{1,19}\/publish|media\/(?:upload|metadata))$/.test(path);
    if (!valid || (body !== undefined && Buffer.byteLength(body) > (path === "/2/media/upload" ? 7 : 1) * 1024 * 1024))
      throw new RemoteOperationError("invalidInput", "rejected");
    if (!/^[\x21-\x7e]{1,8192}$/.test(access.accessToken))
      throw new RemoteOperationError("authorizationRequired", "rejected");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, response: Response | undefined;
    try {
      try {
        await access.guard();
      } catch {
        throw new RemoteOperationError("authorizationChanged", "rejected");
      }
      response = await this.send("https://api.x.com" + path, {
        method,
        headers: {
          authorization: "Bearer " + access.accessToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 429) throw new RemoteOperationError("rateLimited", "rejected");
      if ([401, 403].includes(response.status)) throw new RemoteOperationError("platformPermissionDenied", "rejected");
      if (response.status === 402) throw new RemoteOperationError("platformPaymentRequired", "rejected");
      if ([400, 404, 405, 413, 415, 422].includes(response.status))
        throw new RemoteOperationError("platformRejected", "rejected");
      if (!response.ok) throw new RemoteOperationError("platformUnavailable", "unknown");
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body)
        throw new RemoteOperationError("invalidPlatformResponse", "unknown");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 128 * 1024) throw new RemoteOperationError("invalidPlatformResponse", "unknown");
        chunks.push(part.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new RemoteOperationError("invalidPlatformResponse", "unknown");
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RemoteOperationError) throw error;
      throw new RemoteOperationError("platformUnavailable", "unknown");
    } finally {
      controller.abort();
      clearTimeout(timer);
      void reader?.cancel().catch(() => {});
      if (!reader) void response?.body?.cancel().catch(() => {});
    }
  }
}
