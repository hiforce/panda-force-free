const routes = new Set(["workspace", "tasks", "projects", "project", "deliverables", "connections", "new", "task"]);

export function parseWorkbenchRoute(url = new URL(location.href)) {
  const parts = url.pathname.split("/").filter(Boolean);
  const page = parts[0] === "settings" ? "settings" : routes.has(parts[0]) ? parts[0] : "workspace";
  let id = "";
  try {
    id = decodeURIComponent(parts[1] || "");
  } catch {
    /* Invalid identifiers are handled as unavailable tasks. */
  }
  return {
    page,
    id: page === "project" ? url.searchParams.get("id") || "" : id,
    projectId: url.searchParams.get("project") || "",
  };
}
