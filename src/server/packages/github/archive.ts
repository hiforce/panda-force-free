import { SourceError, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import type { SourceHttpPort } from "../source-http.js";
import { GitHubSourceClient } from "./client.js";

/** Only the archive URL issued for this pinned repository can receive the short-lived download query. */
function archiveUrl(value: string, client: GitHubSourceClient, commit: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceError("invalidSource");
  }
  const prefix = `/${client.repository.owner}/${client.repository.name}/`.toLowerCase();
  if (
    url.origin !== "https://codeload.github.com" ||
    url.username ||
    url.password ||
    url.hash ||
    ![prefix + "legacy.zip/" + commit, prefix + "zip/" + commit].includes(url.pathname.toLowerCase())
  )
    throw new SourceError("invalidSource");
  return url.href;
}

/** API credentials never cross to the archive host, and the selected grant is checked again before that request. */
export async function downloadGitHubArchive(
  http: SourceHttpPort,
  client: GitHubSourceClient,
  commit: string,
  limits: SourceLimits,
  signal?: AbortSignal,
) {
  const url = archiveUrl(await client.archiveLocation(commit, signal), client, commit);
  await client.authorize(signal);
  let response;
  try {
    response = await http.get({
      url,
      headers: { Accept: "application/zip", "User-Agent": "PandaForce-source-import" },
      maxBytes: limits.archiveBytes,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw new SourceError("sourceCancelled");
    throw error instanceof SourceError ? error : new SourceError("sourceUnavailable");
  }
  if (signal?.aborted) throw new SourceError("sourceCancelled");
  if (response.status === 429 || (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0"))
    throw new SourceError("sourceRateLimited");
  if ([401, 403].includes(response.status)) throw new SourceError("sourceAccessDenied");
  if (response.status !== 200) throw new SourceError("sourceUnavailable");
  if (response.bytes.byteLength > limits.archiveBytes) throw new SourceError("sourceTooLarge");
  return new Uint8Array(response.bytes);
}
