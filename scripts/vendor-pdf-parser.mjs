import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const target = "src/server/materials/vendor",
  provenance = JSON.parse(await readFile(target + "/provenance.json", "utf8")),
  upstream = resolve(process.argv[2] || "node_modules/unpdf"),
  metadata = JSON.parse(await readFile(join(upstream, "package.json"), "utf8"));
if (metadata.name !== "unpdf" || metadata.version !== provenance.version)
  throw Error("Expected the reviewed unpdf package version");
if ("Bun " + Bun.version !== provenance.build.runtime)
  throw Error("Use the pinned Bun version to reproduce this parser");
const scratch = await mkdtemp(join(tmpdir(), "panda-pdf-vendor-"));
try {
  for (const [path, hash] of Object.entries(provenance.sourceFiles)) {
    const bytes = await readFile(join(upstream, path));
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw Error("Upstream PDF parser bytes changed: " + path);
    const destination = join(scratch, "unpdf", path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    if (path.includes("LICENSE")) {
      const license = path === "LICENSE" ? "LICENSES/unpdf/LICENSE" : "LICENSES/unpdf/pdfjs/" + path.split("/").at(-1);
      if (!bytes.equals(await readFile(license)))
        throw Error("Retain the complete upstream PDF parser license: " + path);
    }
  }
  const entry = join(scratch, "entry.mjs"),
    output = join(scratch, "parser.mjs");
  await writeFile(entry, "export { getDocumentProxy } from './unpdf/dist/index.mjs';\n");
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      entry,
      "--target=bun",
      "--minify",
      "--external=@napi-rs/canvas",
      "--external=pdfjs-dist",
      "--outfile=" + output,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await child.exited) throw Error("The pinned PDF parser build failed");
  const header =
      "// @ts-nocheck\n// Generated from unpdf 2.2.1. See provenance.json and LICENSES/unpdf; do not edit.\n",
    bytes = Buffer.concat([Buffer.from(header), await readFile(output)]);
  if (createHash("sha256").update(bytes).digest("hex") !== provenance.sha256)
    throw Error("Generated PDF parser differs from the reviewed source hash");
  await writeFile(target + "/pdf-parser.mjs", bytes);
  console.log("Reproduced the pinned PDF text parser and checked its complete upstream notices.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
