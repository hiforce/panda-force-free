import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildInput } from "../shared/builds/contracts.js";
import { BuildError } from "../shared/builds/validation.js";
import { trustedThemeExport } from "../shared/builds/trusted-theme.js";

/** Called after the whole frozen bundle has been verified, inside the no-network worker only. */
export async function materializeInstalledTheme(input: BuildInput, root: string) {
  const snapshot = input.theme;
  if (snapshot?.schema !== 2) return null;
  const selected = trustedThemeExport(snapshot);
  if (selected.engine !== input.engine) throw new BuildError("invalidTheme");
  const directory = input.engine === "hexo" ? "themes/panda-installed" : "panda-theme";
  for (const file of snapshot.bundle.files) {
    if (!file.path.startsWith(selected.root + "/")) continue;
    const target = join(root, directory, file.path.slice(selected.root.length + 1));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.data, "base64"), { flag: "wx", mode: 0o600 });
  }
  return { directory, entry: selected.entry ? `./${directory}/${selected.entry}` : null };
}
