import { readFile } from "node:fs/promises";
import { BuildError } from "../../shared/builds/validation.js";
export function registryHost(image: string): string {
  const first = image.split("/")[0];
  return image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")
    ? first
    : "index.docker.io";
}
/** Docker credentials are read only at pull time and never enter a worker environment or job record. */
export async function registryAuthorization(image: string, configFile?: string): Promise<string | undefined> {
  if (!configFile) return undefined;
  let config;
  try {
    const text = await readFile(configFile, "utf8");
    if (text.length > 1024 * 1024) throw new Error();
    config = JSON.parse(text);
  } catch {
    throw new BuildError("registryConfigurationUnavailable", 503);
  }
  const host = registryHost(image),
    keys =
      host === "index.docker.io"
        ? [host, "https://index.docker.io/v1/", "registry-1.docker.io", "docker.io"]
        : [host, `https://${host}`, `https://${host}/v1/`];
  const entry = keys.map((key) => config.auths?.[key]).find((value) => value && typeof value === "object");
  if (!entry) {
    if (config.credsStore || keys.some((key) => config.credHelpers?.[key]))
      throw new BuildError("registryCredentialHelperUnsupported", 503);
    return undefined;
  }
  if (typeof entry.identitytoken === "string" && entry.identitytoken)
    return Buffer.from(JSON.stringify({ serveraddress: host, identitytoken: entry.identitytoken })).toString("base64");
  if (typeof entry.auth !== "string" || !entry.auth) throw new BuildError("registryCredentialsMissing", 503);
  const credentials = Buffer.from(entry.auth, "base64").toString("utf8"),
    separator = credentials.indexOf(":");
  if (separator < 1) throw new BuildError("registryCredentialsInvalid", 503);
  return Buffer.from(
    JSON.stringify({
      serveraddress: host,
      username: credentials.slice(0, separator),
      password: credentials.slice(separator + 1),
    }),
  ).toString("base64");
}
