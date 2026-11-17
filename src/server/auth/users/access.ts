import type { IncomingMessage } from "node:http";
import { localRequestIdentity } from "./identity.js";

/** Called only after authentication. Legacy installation credentials remain administrative during local migration. */
export function sharedWorkspaceAllowed(req: IncomingMessage) {
  return localRequestIdentity(req)?.role !== "member";
}

/** Personal/business APIs retain their own owner and project checks; host and installation APIs default to denied. */
export function memberApiAllowed(path: string, method: string) {
  if (!path.startsWith("/api/")) return true;
  if (
    [
      "/api/config",
      "/api/health",
      "/api/engine",
      "/api/content-access",
      "/api/projects",
      "/api/local-users/self",
    ].includes(path)
  )
    return method === "GET";
  if (path === "/api/local-users/password") return method === "POST";
  if (path.startsWith("/api/personal/")) return true;
  if (path === "/api/creation-materials") return method === "POST";
  if (path === "/api/creation-materials/original") return ["GET", "HEAD"].includes(method);
  if (
    [
      "/api/project-documents/capabilities",
      "/api/creative-assets/capabilities",
      "/api/skills",
      "/api/skill-packs",
      "/api/skill-packs/detail",
      "/api/skill-packs/cover",
      "/api/skill-workspace",
      "/api/template-catalog",
    ].includes(path)
  )
    return method === "GET";
  if (
    /^\/api\/(?:project-documents|document-tree|document-creations|creative-assets|content-sources)(?:\/|$)/.test(path)
  )
    return true;
  return false;
}
