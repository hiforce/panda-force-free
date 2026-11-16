import { BUILD_ENGINES, BUILD_PROTOCOL, type BuildEngine } from "../../shared/builds/contracts.js";
import { BuildError } from "../../shared/builds/validation.js";
import type { ImageSelection } from "../config.js";
import type { DockerApi } from "./api.js";
import { registryAuthorization } from "./registry.js";
import type { BuildRequirements } from "../../shared/builds/capabilities.js";

interface WorkerImageOptions {
  credentials?: string;
  signal?: AbortSignal;
  requirements?: Partial<BuildRequirements>;
}
const capabilityLabels: Record<keyof BuildRequirements, [string, string, string]> = {
  hexoStylus: ["ai.hiforce.panda.hexo-stylus-protocol", "1", "hexoStylusWorkerRequired"],
  themes: ["ai.hiforce.panda.theme-protocol", "1", "themeWorkerRequired"],
  trustedThemes: ["ai.hiforce.panda.trusted-theme-protocol", "1", "trustedThemeWorkerRequired"],
  profileThemes: ["ai.hiforce.panda.profile-theme-protocol", "1", "profileThemeWorkerRequired"],
  siteProjects: ["ai.hiforce.panda.site-project-protocol", "1", "sourceProjectWorkerRequired"],
  nativeResources: ["ai.hiforce.panda.resource-build-protocol", "2", "resourceBuildWorkerRequired"],
};
interface Inspection {
  Id: string;
  RepoDigests?: string[];
  Config: { Labels?: Record<string, string> };
}
function repository(reference: string) {
  const path = reference.split("@")[0]!;
  const tag = path.lastIndexOf(":");
  const name = tag > path.lastIndexOf("/") ? path.slice(0, tag) : path;
  const first = name.split("/")[0]!;
  const canonical =
    name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")
      ? name
      : "docker.io/" + (name.includes("/") ? name : "library/" + name);
  return canonical
    .replace(/^(?:index\.docker\.io|registry-1\.docker\.io)\//, "docker.io/")
    .replace(/^docker\.io\/([^/]+)$/, "docker.io/library/$1");
}
export async function resolveWorkerImage(
  api: DockerApi,
  selection: ImageSelection,
  engine: BuildEngine,
  { credentials, signal, requirements = {} }: WorkerImageOptions = {},
) {
  async function inspect(): Promise<Inspection | null> {
    const response = await api.call("GET", `/images/${encodeURIComponent(selection.reference)}/json`, { signal });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new BuildError("imageInspectionFailed", 503);
    return JSON.parse(response.data.toString("utf8"));
  }
  let found = await inspect();
  if (selection.pullPolicy === "always" || (!found && selection.pullPolicy === "if-not-present")) {
    const auth = await registryAuthorization(selection.reference, credentials);
    const response = await api.call("POST", `/images/create?fromImage=${encodeURIComponent(selection.reference)}`, {
      headers: auth ? { "X-Registry-Auth": auth } : {},
      timeout: 600000,
      limit: 16 * 1024 * 1024,
      signal,
    });
    if (response.status !== 200) throw new BuildError("imagePullFailed", 503);
    for (const line of response.data.toString("utf8").split("\n").filter(Boolean)) {
      try {
        if (JSON.parse(line).error) throw new BuildError("imagePullFailed", 503);
      } catch {
        throw new BuildError("imagePullFailed", 503);
      }
    }
    found = await inspect();
  }
  if (!found) throw new BuildError("imageNotAvailableLocally", 503);
  const labels = found.Config?.Labels || {};
  if (
    labels["ai.hiforce.panda.build-protocol"] !== String(BUILD_PROTOCOL) ||
    labels[`ai.hiforce.panda.engine.${engine}`] !== BUILD_ENGINES[engine]
  )
    throw new BuildError("incompatibleWorkerImage", 503);
  for (const key of Object.keys(capabilityLabels) as (keyof BuildRequirements)[]) {
    const [label, expected, error] = capabilityLabels[key];
    if (requirements[key] && labels[label] !== expected) throw new BuildError(error, 503);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(found.Id)) throw new BuildError("invalidImageIdentity", 503);
  return {
    reference: selection.reference,
    id: found.Id,
    digest:
      found.RepoDigests?.find(
        (value) =>
          /@sha256:[a-f0-9]{64}$/.test(value) &&
          repository(value) === repository(selection.reference) &&
          (!selection.reference.includes("@") || value.split("@")[1] === selection.reference.split("@")[1]),
      ) || null,
  };
}
