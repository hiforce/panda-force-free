import { resolve, relative, isAbsolute } from "node:path";
import { isRecord } from "../../../shared/records.js";

const directories = new Set<string>();
const sessions = new Set<string>();
const roots = new Set<string>();
export function registerApplicationRoot(path: string) {
  roots.add(resolve(path));
}

/** Owned execution threads are implementation details, not user conversations. */
export function trackApplicationDirectory(path: string) {
  const directory = resolve(path);
  directories.add(directory);
  return () => directories.delete(directory);
}
export function rememberApplicationSession(id: string) {
  sessions.add(id);
  while (sessions.size > 10000) sessions.delete(sessions.values().next().value!);
}
export function isApplicationSession(id: string, value?: unknown): boolean {
  if (sessions.has(id)) return true;
  if (
    isRecord(value) &&
    typeof value.cwd === "string" &&
    (directories.has(resolve(value.cwd)) ||
      [...roots].some((root) => {
        const path = relative(root, resolve(value.cwd as string));
        return !path || (!path.startsWith("..") && !isAbsolute(path));
      }))
  ) {
    rememberApplicationSession(id);
    return true;
  }
  return false;
}
