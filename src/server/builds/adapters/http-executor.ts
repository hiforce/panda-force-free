import { THEME_PROTOCOL } from "../../../shared/builds/theme.js";
import { TRUSTED_THEME_PROTOCOL } from "../../../shared/builds/trusted-theme.js";
import { SITE_PROJECT_PROTOCOL } from "../../../shared/builds/project.js";
import { PROFILE_THEME_PROTOCOL } from "../../../shared/builds/profile-identity.js";
import { readFile } from "node:fs/promises";
import {
  BUILD_ENGINES,
  BUILD_PROTOCOL,
  type BuildInput,
  type BuildExecution,
} from "../../../shared/builds/contracts.js";
import type { BuildAvailability } from "../../../shared/builds/jobs.js";
import { buildArtifact, buildId } from "../../../shared/builds/validation.js";
import type { SiteExecutor } from "../executor-port.js";
import { SiteBuildError } from "../errors.js";
import { executionFailure } from "../../../shared/builds/failures.js";
import { assertBuildCapabilities } from "../capabilities.js";
import { RESOURCE_BUILD_PROTOCOL, type ResourceBuildRequest } from "../../../shared/builds/resources.js";
import { HEXO_STYLUS_PROTOCOL, resourceBuildRequirements } from "../../../shared/builds/capabilities.js";
import {
  encodeResourceBuild,
  RESOURCE_FRAME_CONTENT_TYPE,
  RESOURCE_FRAME_TIMEOUT_MS,
} from "../../../shared/builds/resource-frame.js";

type ExecutorFetch = (input: string, init?: RequestInit) => Promise<Response>;
const phases = new Set(["queued", "resolving", "running", "completed", "failed"]);
function execution(value: unknown, id: string): BuildExecution {
  if (!value || typeof value !== "object") throw new SiteBuildError("executorProtocol", 502);
  const row = value as BuildExecution;
  if (
    row.id !== id ||
    !phases.has(row.phase) ||
    !Object.hasOwn(BUILD_ENGINES, row.engine) ||
    !/^[a-f0-9]{64}$/.test(row.inputHash) ||
    !Number.isSafeInteger(row.createdAt) ||
    !Number.isSafeInteger(row.updatedAt)
  )
    throw new SiteBuildError("executorProtocol", 502);
  const image = row.image;
  if (
    image &&
    (typeof image.reference !== "string" ||
      image.reference.length > 300 ||
      !/^sha256:[a-f0-9]{64}$/.test(image.id) ||
      (image.digest !== null && typeof image.digest !== "string"))
  )
    throw new SiteBuildError("executorProtocol", 502);
  return {
    id,
    inputHash: row.inputHash,
    engine: row.engine,
    phase: row.phase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(image ? { image } : {}),
    ...(row.error ? { error: executionFailure(row.error) } : {}),
  };
}
/** The administrator chooses one endpoint; document input cannot redirect authenticated requests. */
export class HttpSiteExecutor implements SiteExecutor {
  private readonly base: string;
  constructor(
    url: string,
    private tokenFile: string,
    private fetcher: ExecutorFetch = fetch,
  ) {
    const parsed = new URL(url);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      throw new Error("Invalid build executor URL");
    this.base = parsed.origin;
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    maximum = 32 * 1024,
    binary?: Uint8Array,
  ): Promise<unknown> {
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), binary ? RESOURCE_FRAME_TIMEOUT_MS : 15_000);
    try {
      const token = (await readFile(this.tokenFile, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new SiteBuildError("executorUnavailable", 503);
      const response = await this.fetcher(this.base + path, {
        method,
        signal: controller.signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": binary ? RESOURCE_FRAME_CONTENT_TYPE : "application/json",
        },
        ...(binary ? { body: Buffer.from(binary) } : body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new SiteBuildError("executorMissing", 404);
        if (response.status === 409) throw new SiteBuildError("executorConflict", 409);
        throw new SiteBuildError("executorUnavailable", 503);
      }
      const reader = response.body?.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      if (!reader) throw new SiteBuildError("executorProtocol", 502);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maximum) throw new SiteBuildError("executorProtocol", 502);
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof SiteBuildError) throw error;
      throw new SiteBuildError("executorUnavailable", 503);
    } finally {
      clearTimeout(timeout);
    }
  }
  async availability(): Promise<BuildAvailability> {
    try {
      await this.request("/health");
      const value = (await this.request("/v1/capabilities")) as {
        protocol?: number;
        features?: unknown;
        engines?: Record<string, unknown>;
      };
      const engines: BuildAvailability["engines"] = {};
      for (const engine of ["hexo", "docusaurus"] as const)
        if (value.engines?.[engine] === BUILD_ENGINES[engine]) engines[engine] = BUILD_ENGINES[engine];
      return {
        state: value.protocol === BUILD_PROTOCOL && Object.keys(engines).length ? "ready" : "incompatible",
        engines,
        themes: Array.isArray(value.features) && value.features.includes(THEME_PROTOCOL),
        trustedThemes: Array.isArray(value.features) && value.features.includes(TRUSTED_THEME_PROTOCOL),
        siteProjects: Array.isArray(value.features) && value.features.includes(SITE_PROJECT_PROTOCOL),
        profileThemes: Array.isArray(value.features) && value.features.includes(PROFILE_THEME_PROTOCOL),
        ...(Array.isArray(value.features) && value.features.includes(RESOURCE_BUILD_PROTOCOL)
          ? { nativeResources: true }
          : {}),
        ...(Array.isArray(value.features) && value.features.includes(HEXO_STYLUS_PROTOCOL) ? { hexoStylus: true } : {}),
      };
    } catch {
      return { state: "unavailable", engines: {} };
    }
  }
  async start(id: string, input: BuildInput) {
    return execution(await this.request(`/v1/builds/${buildId(id)}`, "PUT", input), id);
  }
  async startResource(id: string, input: ResourceBuildRequest) {
    const available = await this.availability();
    if (available.state !== "ready" || available.engines[input.engine] !== BUILD_ENGINES[input.engine])
      throw new SiteBuildError("executorUnavailable", 503);
    if (!available.nativeResources) throw new SiteBuildError("resourceBuildExecutorRequired", 503);
    assertBuildCapabilities(
      input.descriptor.input,
      available,
      resourceBuildRequirements(input.descriptor.input, input.descriptor.files),
    );
    return execution(
      await this.request(`/v2/builds/${buildId(id)}`, "PUT", undefined, 32 * 1024, encodeResourceBuild(input)),
      id,
    );
  }
  async status(id: string) {
    return execution(await this.request(`/v1/builds/${buildId(id)}`), id);
  }
  async cancel(id: string) {
    return execution(await this.request(`/v1/builds/${buildId(id)}`, "DELETE"), id);
  }
  async result(id: string) {
    const value = await this.request(`/v1/builds/${buildId(id)}/result`, "GET", undefined, 96 * 1024 * 1024);
    try {
      return buildArtifact(value);
    } catch {
      throw new SiteBuildError("executorProtocol", 502);
    }
  }
  async logs(id: string) {
    const value = (await this.request(`/v1/builds/${buildId(id)}/logs`, "GET", undefined, 1024 * 1024)) as {
      logs?: unknown;
    };
    if (typeof value.logs !== "string" || Buffer.byteLength(value.logs) > 128 * 1024)
      throw new SiteBuildError("executorProtocol", 502);
    return value.logs;
  }
}
