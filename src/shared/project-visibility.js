// Use the same lexical path identity in the browser and the visibility store.
export function normalizeProjectPath(path, home = "") {
  if (typeof path !== "string" || !path || path.includes("\0")) return null;
  if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
  if (!path.startsWith("/")) return null;
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

// Visibility identities include explicit product projects and legacy folder paths.
export function normalizeProjectVisibilityKey(value, home = "") {
  if (typeof value === "string" && /^project:[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) return value;
  return normalizeProjectPath(value, home);
}
