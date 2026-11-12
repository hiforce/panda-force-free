import { createReadStream, readFileSync } from "node:fs";
import { reportDiagnostic } from "../../shared/diagnostics.js";
import { saveAttachment } from "../workspace/attachments.js";
import { ensureAttachmentWorkspace } from "../workspace/attachment-workspace.js";
import { readWorkspaceContext } from "../workspace/context.js";
import { listWorkspaceEntries } from "../workspace/entries.js";
import { resolveLocalFile } from "../workspace/files.js";
import { isDirectory, listFolders, resolveBrowsePath } from "../workspace/folders.js";
import { readGitDiff, readGitHistory, readGitStatus } from "../workspace/git.js";
import { resolveLocalImage } from "../workspace/images.js";
import { searchWorkspaceFiles } from "../workspace/search.js";
import { errorCode, errorMessage, errorStatus } from "./../../shared/errors.js";
import type { RuntimeServices } from "./../services.js";
import { respondError, respondJson } from "./respond.js";
import type { Route } from "./router.js";

/** Owns workspace routes. Dependencies are supplied by the composition root. */
export function workspaceRoutes({
  attachmentStorage,
  imageThumbnail,
  homeDir,
  defaultCwd,
  browseRoots,
  attachmentRoot,
  imageRoots,
  fileRoots,
  threadHub,
  projectWorkspaces,
  directoryPolicy,
  encodeContentDispositionFilename,
}: Pick<
  RuntimeServices,
  | "attachmentStorage"
  | "imageThumbnail"
  | "homeDir"
  | "defaultCwd"
  | "browseRoots"
  | "attachmentRoot"
  | "imageRoots"
  | "fileRoots"
  | "threadHub"
  | "projectWorkspaces"
  | "directoryPolicy"
  | "encodeContentDispositionFilename"
>): Route[] {
  return [
    {
      path: "/api/composer/history",
      method: "GET",
      handler: async ({ res }) => {
        try {
          const entries = await threadHub.readComposerHistory(
            directoryPolicy.allowExternal
              ? undefined
              : {
                  includeSession: async (id) => {
                    try {
                      return directoryPolicy.remember(await threadHub.getThreadMetadata(id));
                    } catch {
                      return false;
                    }
                  },
                },
          );
          respondJson(res, 200, { entries });
        } catch (error) {
          reportDiagnostic("composer.history", error);
          respondJson(res, 500, { error: "Could not read composer history" });
        }
      },
    },
    {
      path: "/api/attachments",
      method: "POST",
      handler: async ({ req, res, url }) => {
        try {
          let root = attachmentRoot;
          if (!attachmentStorage) {
            const threadId = url.searchParams.get("threadId"),
              projectId = url.searchParams.get("projectId");
            const cwd = threadId
              ? (await threadHub.getThreadMetadata(threadId)).cwd
              : projectId
                ? (await projectWorkspaces.ensure(projectId)).path
                : url.searchParams.get("cwd");
            // Older clients without a destination keep their persistent staging location.
            if (cwd) root = ensureAttachmentWorkspace(cwd, browseRoots).input;
            else if (threadId || projectId) throw new Error("Attachment workspace is unavailable");
          }
          const attachment = await saveAttachment(req, root, url.searchParams.get("name"), attachmentStorage);
          respondJson(res, 201, { attachment });
        } catch (error) {
          respondJson(res, errorStatus(error) || 400, {
            error: errorCode(error) ? "Could not save attachment" : errorMessage(error),
          });
        }
      },
    },
    {
      path: "/api/attachments/read",
      method: ["GET", "HEAD"],
      handler: async ({ res, url }) => {
        try {
          if (!attachmentStorage) throw new Error("OSS attachment storage is disabled");
          const location = await attachmentStorage.readUrl(url.searchParams.get("url"));
          res.writeHead(302, { location, "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
          res.end();
        } catch (error) {
          reportDiagnostic("attachments.read", error);
          respondJson(res, 404, { error: "Attachment unavailable" });
        }
      },
    },
    {
      path: "/api/workspace/context",
      handler: ({ res, url }) => {
        try {
          const context = readWorkspaceContext(url.searchParams.get("cwd") || defaultCwd, browseRoots);
          respondJson(res, 200, context);
        } catch (error) {
          respondError(res, 400, error);
        }
      },
    },
    {
      path: "/api/files/search",
      handler: async ({ res, url }) => {
        try {
          const cwd = url.searchParams.get("cwd") || defaultCwd;
          const query = url.searchParams.get("query") || "";
          const items = await searchWorkspaceFiles(cwd, query, { allowedRoots: browseRoots, limit: 30 });
          respondJson(res, 200, { cwd, query, items });
        } catch (error) {
          respondError(res, 400, error);
        }
      },
    },
    {
      path: "/api/workspace/tree",
      method: "GET",
      handler: ({ res, url }) => {
        try {
          const cwd = url.searchParams.get("cwd") || defaultCwd;
          const path = url.searchParams.get("path") || "";
          const result = listWorkspaceEntries(cwd, path, { allowedRoots: fileRoots });
          respondJson(res, 200, result);
        } catch (error) {
          respondError(res, 400, error);
        }
      },
    },
    {
      path: ["/api/git/status", "/api/git/diff", "/api/git/history"],
      method: "GET",
      handler: ({ res, url }) => {
        try {
          const cwd = url.searchParams.get("cwd") || defaultCwd;
          let result;
          if (url.pathname === "/api/git/status") result = readGitStatus(cwd, fileRoots);
          else if (url.pathname === "/api/git/diff")
            result = readGitDiff(cwd, url.searchParams.get("path"), {
              allowedRoots: fileRoots,
              scope: url.searchParams.get("scope") || "head",
              commit: url.searchParams.get("commit") || "",
            });
          else
            result = readGitHistory(cwd, url.searchParams.get("path"), {
              allowedRoots: fileRoots,
              limit: Number(url.searchParams.get("limit") || 50),
            });
          respondJson(res, 200, result);
        } catch (error) {
          respondError(res, 400, error);
        }
      },
    },
    {
      path: "/api/files/download",
      method: "GET",
      handler: ({ req, res, url }) => {
        try {
          const file = resolveLocalFile(url.searchParams.get("path"), {
            cwd: url.searchParams.get("cwd") || defaultCwd,
            home: homeDir,
            // Uploaded files remain downloadable without exposing their directory in the browser.
            allowedRoots: [...fileRoots, attachmentRoot],
          });
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(file.size),
            "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeContentDispositionFilename(file.filename)}`,
            "cache-control": "no-store",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
          });
          const stream = createReadStream(file.path);
          stream.on("error", () => res.destroy());
          req.on("aborted", () => stream.destroy());
          stream.pipe(res);
        } catch (error) {
          reportDiagnostic("files.download", error);
          respondJson(res, 404, { error: "File unavailable" });
        }
      },
    },
    {
      path: "/api/images/local",
      method: "GET",
      handler: async ({ res, url }) => {
        try {
          const image = resolveLocalImage(url.searchParams.get("path"), {
            cwd: url.searchParams.get("cwd") || defaultCwd,
            home: homeDir,
            allowedRoots: imageRoots,
          });
          const thumbnail = url.searchParams.get("thumbnail") === "1";
          const bytes = thumbnail ? await imageThumbnail(image) : readFileSync(image.path);
          res.writeHead(200, {
            "content-type": thumbnail ? "image/webp" : image.contentType,
            "content-length": String(bytes.length),
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(thumbnail ? `${image.filename}.webp` : image.filename)}`,
            "cache-control": thumbnail ? "private, no-cache" : "private, max-age=60",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
          });
          res.end(bytes);
        } catch (error) {
          respondJson(res, errorStatus(error) === 503 ? 503 : 404, { error: "Image unavailable" });
        }
      },
    },
    {
      path: "/api/folders",
      handler: ({ res, url }) => {
        try {
          const path = resolveBrowsePath(
            url.searchParams.get("path") || (directoryPolicy.allowExternal ? "~" : defaultCwd),
            browseRoots,
            homeDir,
          );
          if (!isDirectory(path)) throw new Error("Directory not found");
          respondJson(res, 200, listFolders(path, browseRoots));
        } catch (error) {
          respondError(res, 400, error);
        }
      },
    },
  ];
}
