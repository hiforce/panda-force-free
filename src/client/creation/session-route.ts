import { parseWorkbenchRoute } from "../workbench-route.js";

/** Public creation identity is independent of an engine thread and its execution lease. */
export function creationSessionRoute(url = new URL(location.href)) {
  const route = parseWorkbenchRoute(url);
  if (route.page === "creation") {
    const scope = url.searchParams.get("creationScope") === "personal" ? "personal" : "application";
    return { id: route.id, scope, key: `creation:${scope}:${route.id}` } as const;
  }
  if (route.page === "create" && url.searchParams.get("view") !== "works" && !url.searchParams.has("asset"))
    return { id: "", scope: "personal", key: "creation:personal:new" } as const;
  return null;
}
