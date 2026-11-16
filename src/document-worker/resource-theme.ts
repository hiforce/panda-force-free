import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResourceBuildRequest } from "../shared/builds/resources.js";

/** Only verified effective resource bytes enter this private, fixed worker directory. */
export async function materializeResourceTheme(request: ResourceBuildRequest, root: string) {
  const directory = request.engine === "hexo" ? "themes/panda-installed" : "panda-theme";
  for (const file of request.tree.files) {
    const target = join(root, directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, request.tree.read(file.path), { flag: "wx", mode: 0o600 });
  }
  const entry = request.descriptor.theme.entry;
  return { directory, entry: entry ? `./${directory}/${entry}` : null };
}
