import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConnectionError } from "../../connections/errors.js";
import type { PublicationAccess } from "../ports.js";

function canonical(path: string): string {
  let parent = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(parent), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent) throw error;
      missing.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}
function contains(root: string, path: string) {
  const suffix = relative(root, path);
  return !suffix || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix));
}

/** Source roots are immutable space metadata; their filesystem aliases are checked again before every effect. */
export function publicationAccess(assertCurrent: () => void, roots: readonly string[]): PublicationAccess {
  return {
    assertCurrent,
    assertDestination(path) {
      const destination = canonical(path);
      for (const root of roots) {
        const source = canonical(root);
        if (contains(source, destination) || contains(destination, source))
          throw new ConnectionError("protectedPath", 403);
      }
    },
  };
}
