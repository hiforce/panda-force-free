import { BuildError } from "../shared/builds/validation.js";
import type { BuildEngine } from "../shared/builds/contracts.js";
export type PullPolicy = "always" | "if-not-present" | "never";
export interface ImageSelection {
  reference: string;
  pullPolicy: PullPolicy;
}
export interface ExecutorConfig {
  stateRoot: string;
  tokenFile: string;
  dockerSocket: string;
  registryConfigFile?: string;
  images: Record<BuildEngine, ImageSelection>;
  timeoutMs: number;
  port: number;
}
export function imageReference(value: string): string {
  if (
    value.length > 300 ||
    !/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127}|@sha256:[a-f0-9]{64})$/.test(
      value,
    )
  )
    throw new BuildError("invalidImageReference");
  return value;
}
export function pullPolicy(value: string): PullPolicy {
  if (!["always", "if-not-present", "never"].includes(value)) throw new BuildError("invalidPullPolicy");
  return value as PullPolicy;
}
export function executorConfig(env: Record<string, string | undefined>): ExecutorConfig {
  const policy = pullPolicy(env.PANDA_FORCE_ENGINE_PULL_POLICY || "if-not-present");
  const timeoutMs = Number(env.PANDA_FORCE_BUILD_TIMEOUT_SECONDS || "300") * 1000;
  const port = Number(env.PORT || "8900");
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10000 ||
    timeoutMs > 1800000 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new BuildError("invalidExecutorLimits");
  return {
    stateRoot: env.PANDA_FORCE_EXECUTOR_HOME || "/var/lib/panda-executor",
    tokenFile: env.PANDA_FORCE_EXECUTOR_TOKEN_FILE || "/run/panda-executor/token",
    dockerSocket: env.PANDA_FORCE_DOCKER_SOCKET || "/var/run/docker.sock",
    registryConfigFile: env.PANDA_FORCE_REGISTRY_CONFIG_FILE,
    timeoutMs,
    port,
    images: {
      hexo: {
        reference: imageReference(env.PANDA_FORCE_HEXO_IMAGE || "hiforceai/panda-force-document-worker:1.0.0"),
        pullPolicy: pullPolicy(env.PANDA_FORCE_HEXO_PULL_POLICY || policy),
      },
      docusaurus: {
        reference: imageReference(env.PANDA_FORCE_DOCUSAURUS_IMAGE || "hiforceai/panda-force-document-worker:1.0.0"),
        pullPolicy: pullPolicy(env.PANDA_FORCE_DOCUSAURUS_PULL_POLICY || policy),
      },
    },
  };
}
