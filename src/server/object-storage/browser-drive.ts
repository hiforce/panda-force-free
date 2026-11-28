import type { StorageBrowserEntry } from "../../shared/workspace-tools/storage-browser.js";
import { OAuthHttp } from "../connections/oauth/http.js";
import { OAuthError } from "../connections/oauth/errors.js";
import { StorageBrowseError } from "./browser-errors.js";

const driveApi = "https://www.googleapis.com/drive/v3/files",
  folderMime = "application/vnd.google-apps.folder";
const idPattern = /^[A-Za-z0-9_-]{1,256}$/;
function safeGoogleUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["docs.google.com", "drive.google.com"].includes(url.host)
    )
      return url.href;
  } catch {
    return;
  }
}

export async function driveBrowser(secret: Record<string, unknown>, send: typeof fetch = fetch) {
  const { clientId, clientSecret, refreshToken } = secret;
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || typeof refreshToken !== "string")
    throw new StorageBrowseError("unavailable", 503);
  const http = new OAuthHttp(send, 15000, 1024 * 1024);
  let token;
  try {
    token = await http.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (error) {
    if (error instanceof OAuthError && error.code === "authorizationRejected")
      throw new StorageBrowseError("driveAuthorization", 403);
    throw error;
  }
  if (typeof token.access_token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token.access_token))
    throw new StorageBrowseError("unavailable", 503);
  const headers = { authorization: "Bearer " + token.access_token };
  async function read(path: string, query: Record<string, string>) {
    const url = driveApi + path + "?" + new URLSearchParams(query);
    try {
      return await http.request(url, { headers });
    } catch (error) {
      if (error instanceof OAuthError && error.status === 404) notFound();
      if (error instanceof OAuthError && error.code === "authorizationRejected")
        throw new StorageBrowseError("denied", 403);
      throw error;
    }
  }
  function recordId(id: string) {
    if (!idPattern.test(id)) throw new StorageBrowseError("invalidPath", 400);
    return "/" + id;
  }
  function notFound(): never {
    throw new StorageBrowseError("missing", 404);
  }
  return {
    async list(id: string, cursor: string) {
      const path = recordId(id || "root");
      const [data, folder] = await Promise.all([
        read("", {
          q: `'${id || "root"}' in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,capabilities(canDownload))",
          pageSize: "80",
          orderBy: "folder,name_natural",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(cursor ? { pageToken: cursor } : {}),
        }),
        id ? read(path, { fields: "id,name,mimeType,parents,trashed", supportsAllDrives: "true" }) : null,
      ]);
      if (folder && (folder.mimeType !== folderMime || folder.trashed || typeof folder.name !== "string")) notFound();
      if (!Array.isArray(data.files)) throw new StorageBrowseError("unavailable", 503);
      const entries: StorageBrowserEntry[] = [];
      for (const row of data.files) {
        if (!row || typeof row.id !== "string" || !idPattern.test(row.id) || typeof row.name !== "string") continue;
        if (row.mimeType === folderMime) {
          entries.push({ kind: "folder", id: row.id, name: row.name });
          continue;
        }
        const bytes = typeof row.size === "string" ? Number(row.size) : NaN;
        const googleDocument =
          typeof row.mimeType === "string" && row.mimeType.startsWith("application/vnd.google-apps.");
        entries.push({
          kind: "file",
          id: row.id,
          name: row.name,
          ...(Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes } : {}),
          ...(typeof row.modifiedTime === "string" && Number.isFinite(Date.parse(row.modifiedTime))
            ? { modified: row.modifiedTime }
            : {}),
          ...(googleDocument || row.capabilities?.canDownload === false
            ? { openUrl: safeGoogleUrl(row.webViewLink) }
            : { download: true }),
        });
      }
      const parent =
        folder &&
        Array.isArray(folder.parents) &&
        typeof folder.parents[0] === "string" &&
        idPattern.test(folder.parents[0])
          ? folder.parents[0]
          : "";
      return {
        path: folder ? [{ id, name: String(folder.name) }] : [],
        parent,
        entries,
        next: typeof data.nextPageToken === "string" ? data.nextPageToken : "",
      };
    },
    async download(id: string, signal: AbortSignal) {
      const path = recordId(id);
      const file = await read(path, {
        fields: "id,name,mimeType,trashed,capabilities(canDownload)",
        supportsAllDrives: "true",
      });
      if (file.trashed || typeof file.name !== "string" || typeof file.mimeType !== "string") notFound();
      if (
        file.mimeType.startsWith("application/vnd.google-apps.") ||
        (file.capabilities as { canDownload?: boolean } | undefined)?.canDownload === false
      )
        throw new StorageBrowseError("denied", 403);
      const response = await send(driveApi + path + "?alt=media&supportsAllDrives=true", {
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
      });
      if (response.status === 200) return { response, name: file.name };
      void response.body?.cancel().catch(() => {});
      if (response.status === 404) return notFound();
      if ([401, 403].includes(response.status)) throw new StorageBrowseError("denied", 403);
      throw new StorageBrowseError("unavailable", 503);
    },
  };
}
