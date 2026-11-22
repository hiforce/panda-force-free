import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const payload = {
  "zcode.cjs": "resources/glm/zcode.cjs",
  "zcode-builtin.json": "resources/config/provider/zcode-builtin.json",
  "THIRD-PARTY-NOTICES.md": "resources/THIRD-PARTY-NOTICES.md",
};
const notices = ["LICENSE", "NOTICE.md"];
const lockPath = new URL("./zcode-runtime.lock.json", import.meta.url);
const lock = JSON.parse(await readFile(lockPath, "utf8"));
if (process.platform !== "linux" || process.arch !== "x64" || lock.platform !== "linux/amd64")
  throw Error("The pinned ZCode build requires Linux amd64");

async function verifyFile(path, expected) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest("hex") !== expected) throw Error(`ZCode checksum mismatch for ${path}`);
}

const [action, directory, archive] = process.argv.slice(2);
if (!directory || !["prepare", "verify"].includes(action) || (action === "prepare" && !archive))
  throw Error("Usage: node zcode-runtime.mjs prepare OUTPUT OFFICIAL_APPIMAGE | verify OUTPUT");
const output = resolve(directory);
if (action === "prepare") {
  const appimage = resolve(archive);
  await verifyFile(appimage, lock.archive.sha256);
  const extraction = await mkdtemp(join(tmpdir(), "panda-zcode-"));
  try {
    await mkdir(output, { recursive: true });
    const runtime = join(extraction, "zcode.AppImage");
    await copyFile(appimage, runtime);
    await chmod(runtime, 0o700);
    for (const [name, path] of Object.entries(payload)) {
      execFileSync(runtime, ["--appimage-extract", path], { cwd: extraction, timeout: 60000 });
      await copyFile(join(extraction, "squashfs-root", path), join(output, name));
    }
    for (const name of notices) {
      const url = `https://raw.githubusercontent.com/zai-org/ZCode/${lock.upstreamRevision}/${name}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error(`Cannot fetch pinned ZCode notice (${response.status})`);
      await writeFile(join(output, name), Buffer.from(await response.arrayBuffer()));
    }
    await copyFile(lockPath, join(output, "zcode-runtime.lock.json"));
    await copyFile(fileURLToPath(import.meta.url), join(output, "zcode-runtime.mjs"));
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}
for (const name of [...Object.keys(payload), ...notices]) await verifyFile(join(output, name), lock.files[name]);
console.log(`Verified ZCode ${lock.version} / CLI ${lock.cliVersion} (${lock.platform})`);
