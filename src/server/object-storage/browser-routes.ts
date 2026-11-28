import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  storageBrowserApiPath,
  storageBrowserConnectionId,
  storageBrowserDownloadPath,
  type StorageBrowserPage,
} from "../../shared/workspace-tools/storage-browser.js";
import { respondJson } from "../http/respond.js";
import type { Route, RouteContext } from "../http/router.js";
import { driveBrowser } from "./browser-drive.js";
import { StorageBrowseError } from "./browser-errors.js";
import { ObjectStorageError } from "./contracts.js";
import type { StorageRegistration } from "./registration.js";
import { objectBrowserKey } from "./s3-list.js";
import { s3UriEncode } from "./sigv4.js";

const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

function invalid(): never {
  throw new StorageBrowseError("invalidPath", 400);
}
function respondFailure(context: RouteContext, error: unknown) {
  if (error instanceof StorageBrowseError)
    return respondJson(context.res, error.status, { error: { messageId: `storageBrowser.${error.label}` } }, headers);
  if (error instanceof ObjectStorageError) {
    if (error.code === "storageDenied") return respondFailure(context, new StorageBrowseError("denied", 403));
    if (error.status === 404) return respondFailure(context, new StorageBrowseError("missing", 404));
    if (error.code === "storageInvalidConfiguration")
      return respondFailure(context, new StorageBrowseError("invalidPath", 400));
  }
  respondFailure(context, new StorageBrowseError("unavailable", 503));
}

export function storageBrowserRoutes(options: {
  storage: StorageRegistration;
  authenticationConfigured(): boolean;
  administrator(context: RouteContext): boolean;
}): Route[] {
  return [
    {
      path: [storageBrowserApiPath, storageBrowserDownloadPath],
      method: "GET",
      async handler(context) {
        const { url, req, res } = context;
        if (!options.authenticationConfigured() || !options.administrator(context))
          return respondJson(res, 403, { error: { messageId: "storageConnections.administrator" } }, headers);
        const controller = new AbortController();
        const close = () => controller.abort();
        res.once("close", close);
        try {
          const connection = url.searchParams.get("connection"),
            cursor = url.searchParams.get("cursor") || "",
            folder = url.searchParams.get("folder") || "",
            file = url.pathname === storageBrowserDownloadPath ? url.searchParams.get("file") : null;
          if (
            !connection ||
            !storageBrowserConnectionId(connection) ||
            cursor.length > 8192 ||
            /[\p{Cc}\p{Cs}]/u.test(cursor) ||
            (url.pathname === storageBrowserDownloadPath && !file)
          )
            invalid();
          const registered = await options.storage.browseConnection(connection);
          if (!registered) throw new StorageBrowseError("missing", 404);
          const { provider, name } = registered;
          const list = (page: Omit<StorageBrowserPage, "provider" | "name">) =>
            respondJson(res, 200, { name, provider, ...page }, headers);

          let result: { response: Response; name: string };
          if ("secret" in registered) {
            const drive = await driveBrowser(registered.secret);
            if (!file) return list({ location: registered.account, ...(await drive.list(folder, cursor)) });
            result = await drive.download(file, controller.signal);
          } else {
            const { profile, client } = registered.target;
            const base = profile.prefix ? profile.prefix + "/" : "";
            if (!file) {
              if (folder && (!objectBrowserKey(folder, true) || !folder.startsWith(base))) invalid();
              const current = folder || base;
              let prefix = base;
              const path = current
                .slice(base.length)
                .split("/")
                .filter(Boolean)
                .map((part) => {
                  prefix += part + "/";
                  return { name: part, id: prefix };
                });
              return list({
                location: [profile.bucket, profile.prefix].filter(Boolean).join("/"),
                path,
                parent: path.at(-2)?.id ?? "",
                ...(await client.listDirectory(current, cursor, controller.signal)),
              });
            }
            if (!file.startsWith(base) || !objectBrowserKey(file)) invalid();
            result = { name: file.split("/").at(-1)!, response: await client.browserDownload(file, controller.signal) };
          }
          const length = result.response.headers.get("content-length");
          res.writeHead(200, {
            ...headers,
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="download"; filename*=UTF-8''${s3UriEncode(result.name.replace(/[\p{Cc}\p{Cs}]/gu, "_"))}`,
            "cross-origin-resource-policy": "same-origin",
            ...(length && /^\d+$/.test(length) && !result.response.headers.has("content-encoding")
              ? { "content-length": length }
              : {}),
          });
          if (result.response.body) await pipeline(Readable.from(result.response.body), res);
          else res.end();
        } catch (error) {
          if (res.destroyed) return;
          if (res.headersSent) res.destroy();
          else respondFailure(context, error);
        } finally {
          res.off("close", close);
        }
      },
    },
  ];
}
