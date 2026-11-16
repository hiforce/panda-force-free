/** Personal content is a content scope, never a business project or a session association. */
export const PERSONAL_CONTENT_SCOPE = "personal";
export function personalContentPath(path: string, body?: unknown): string {
  const url = new URL(path, "http://content.invalid");
  const project = body && typeof body === "object" ? (body as { projectId?: unknown }).projectId : undefined;
  return (url.searchParams.get("project") === PERSONAL_CONTENT_SCOPE || project === PERSONAL_CONTENT_SCOPE) &&
    url.pathname.startsWith("/api/project-")
    ? path.replace("/api/", "/api/personal/")
    : path;
}
