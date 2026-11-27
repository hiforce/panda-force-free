import { remoteTerminalId } from "../shared/workspace-tools/remote.js";

const routes = new Set([
  "workspace",
  "bots",
  "tasks",
  "projects",
  "project",
  "deliverables",
  "connections",
  "documents",
  "create",
  "creation",
  "skills",
  "publish",
  "tools",
  "new",
  "task",
]);

/** Keep application links in the live workspace while preserving native browser actions. */
export function workbenchLinkPath(anchor, event, base = location.href) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    anchor.hasAttribute("download") ||
    anchor.hasAttribute("data-native-navigation") ||
    (anchor.target && anchor.target !== "_self") ||
    anchor.relList.contains("external")
  )
    return null;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return null;
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  const current = new URL(base),
    page = url.pathname.split("/").filter(Boolean)[0];
  if (
    url.origin !== current.origin ||
    !["http:", "https:"].includes(url.protocol) ||
    remoteTerminalId(url.pathname) ||
    (page && page !== "settings" && !routes.has(page)) ||
    (url.pathname === current.pathname && url.search === current.search && url.hash)
  )
    return null;
  return url.pathname + url.search + url.hash;
}

export function parseWorkbenchRoute(url = new URL(location.href)) {
  const parts = url.pathname.split("/").filter(Boolean);
  const page =
    parts[0] === "task" && url.searchParams.has("memoryMessage")
      ? "memory-source"
      : ["create", "workspace"].includes(parts[0]) && url.searchParams.has("creation")
        ? "creation"
        : parts[0] === "settings"
          ? "settings"
          : routes.has(parts[0])
            ? parts[0]
            : "workspace";
  let id = "";
  try {
    id = decodeURIComponent(parts[1] || "");
  } catch {
    /* Invalid identifiers are handled as unavailable tasks. */
  }
  return {
    page,
    id:
      page === "project"
        ? url.searchParams.get("id") || ""
        : page === "creation"
          ? url.searchParams.get("creation") || id
          : id,
    projectId: url.searchParams.get("project") || "",
    documentId: url.searchParams.get("document") || "",
  };
}

/** Route identity owns the surface; transient layout classes never decide navigation or keyboard policy. */
export function workbenchRouteSurface(url = new URL(location.href), route = parseWorkbenchRoute(url)) {
  if (route.page === "settings") return "settings";
  if (
    ["new", "task", "creation"].includes(route.page) ||
    (route.page === "create" &&
      !["works", "activity"].includes(url.searchParams.get("view") || "") &&
      !url.searchParams.has("asset"))
  )
    return "conversation";
  return "workspace";
}

/** Bot conversations retain their own workspace while using a docked reading surface. */
export function isBotConversationRoute(url = new URL(location.href)) {
  return /^\/bots\/[a-f0-9-]{36}\/chat$/.test(url.pathname);
}
