import { createHash } from "node:crypto";
import type { ProjectContentView } from "../../project-content/read-view.js";

/** Search follows saved originals, visibility and ancestry, independently of knowledge or attachment history. */
export function savedSearchVersion(view: ProjectContentView): string {
  const paths = view.paths
    .filter(
      (path) =>
        ["project.json", "tree.json", "languages.json", "import.json"].includes(path) ||
        /^(?:documents|spaces)\//.test(path),
    )
    .sort();
  return createHash("sha256")
    .update(JSON.stringify(["saved-document-search/1", paths.map((path) => [path, view.version(path)])]))
    .digest("hex");
}
