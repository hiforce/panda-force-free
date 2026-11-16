import http from "node:http";
import https from "node:https";
import { readFile, stat } from "node:fs/promises";
import type { SearchConnection } from "../connection.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { parseSearchResponse } from "./response-json.js";
/** Only status is retained; upstream bodies and authentication data never become application diagnostics. */
export class SearchHttpError extends SearchError {
  constructor(readonly responseStatus: number) {
    super(
      responseStatus === 401 || responseStatus === 403 ? "forbidden" : "unavailable",
      responseStatus === 401 || responseStatus === 403 ? 403 : 503,
    );
  }
}
async function secret(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 128 * 1024) throw new SearchError("configuration", 503);
  const data = await readFile(path, "utf8");
  if (data.length > 128 * 1024) throw new SearchError("configuration", 503);
  return data.trim();
}
/** Endpoints and secret paths come only from administrator configuration. Redirects and remote error bodies are never forwarded. */
export class SearchHttp {
  constructor(
    readonly connection: SearchConnection,
    private credentials?: () => Promise<{ password?: string; apiKey?: string; ca?: string }>,
  ) {}
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    allowed = [200, 201],
    timeoutMs = 15000,
  ): Promise<Record<string, unknown>> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new SearchError("configuration", 503);
    const deadline = AbortSignal.timeout(timeoutMs),
      requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const endpoint = new URL(this.connection.url + path),
      headers: Record<string, string> = { "content-type": "application/json" };
    const stored = (await this.credentials?.()) ?? {};
    const apiKey = stored.apiKey ?? (this.connection.apiKeyFile ? await secret(this.connection.apiKeyFile) : undefined),
      password =
        stored.password ?? (this.connection.passwordFile ? await secret(this.connection.passwordFile) : undefined);
    if (apiKey) headers.authorization = (this.connection.kind === "elasticsearch" ? "ApiKey " : "Bearer ") + apiKey;
    else if (password) {
      const credentials = this.connection.username + ":" + password;
      headers.authorization =
        this.connection.kind === "milvus"
          ? "Bearer " + credentials
          : "Basic " + Buffer.from(credentials).toString("base64");
    }
    const ca = stored.ca ?? (this.connection.caFile ? await secret(this.connection.caFile) : undefined),
      data = body === undefined ? undefined : JSON.stringify(body);
    if (data && Buffer.byteLength(data) > 128 * 1024 * 1024) throw new SearchError("limit", 409);
    if (data !== undefined) headers["content-length"] = String(Buffer.byteLength(data));
    else if (method === "POST" || method === "PUT") headers["content-length"] = "0";
    return new Promise((resolve, reject) => {
      const fail = () => reject(new SearchError("unavailable", 503));
      const req = (endpoint.protocol === "https:" ? https : http).request(
        endpoint,
        { method, headers, signal: requestSignal, ...(ca ? { ca } : {}) },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
              fail();
              res.destroy();
            } else chunks.push(chunk);
          });
          res.on("error", fail);
          res.on("aborted", fail);
          res.on("end", () => {
            if (!allowed.includes(res.statusCode || 0)) return reject(new SearchHttpError(res.statusCode || 0));
            try {
              const value = parseSearchResponse(
                Buffer.concat(chunks).toString() || "{}",
                this.connection.kind === "milvus",
              );
              if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
              resolve(value);
            } catch {
              fail();
            }
          });
        },
      );
      req.on("error", fail);
      req.end(data ?? (method === "POST" || method === "PUT" ? "" : undefined));
    });
  }
}
