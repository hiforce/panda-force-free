import { request } from "node:http";
import { BuildError } from "../../shared/builds/validation.js";
export interface DockerResponse {
  status: number;
  data: Buffer;
}
export class DockerApi {
  constructor(private socketPath: string) {}
  call(
    method: string,
    path: string,
    options: {
      body?: object;
      headers?: Record<string, string>;
      timeout?: number;
      limit?: number;
      truncate?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<DockerResponse> {
    const body = options.body ? Buffer.from(JSON.stringify(options.body)) : undefined;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path: `/v1.45${path}`,
          signal: options.signal,
          headers: {
            ...(body
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": String(body.length),
                }
              : {}),
            ...options.headers,
          },
        },
        (response) => {
          let length = 0;
          const chunks: Buffer[] = [],
            limit = options.limit ?? 2 * 1024 * 1024;
          response.on("data", (chunk: Buffer) => {
            if (length + chunk.length > limit && !options.truncate) {
              req.destroy(new BuildError("dockerResponseTooLarge", 502));
              return;
            }
            if (length < limit) chunks.push(chunk.subarray(0, limit - length));
            length += chunk.length;
          });
          response.on("error", reject);
          response.on("end", () => resolve({ status: response.statusCode || 500, data: Buffer.concat(chunks) }));
        },
      );
      req.on("error", (error) =>
        reject(
          error instanceof BuildError
            ? error
            : new BuildError(options.signal?.aborted ? "cancelled" : "dockerUnavailable", 503),
        ),
      );
      req.setTimeout(options.timeout || 30000, () => req.destroy(new BuildError("dockerTimeout", 504)));
      req.end(body);
    });
  }
  async json<T>(method: string, path: string, options: Parameters<DockerApi["call"]>[2] = {}): Promise<T> {
    const response = await this.call(method, path, options);
    if (response.status < 200 || response.status >= 300) throw new BuildError(`dockerHttp${response.status}`, 502);
    try {
      return response.data.length ? (JSON.parse(response.data.toString("utf8")) as T) : (undefined as T);
    } catch {
      throw new BuildError("dockerInvalidResponse", 502);
    }
  }
}
