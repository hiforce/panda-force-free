import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { zip, type Zippable } from "fflate";
import type { BuildArtifact } from "../../shared/builds/contracts.js";
import { buildArtifact, buildId } from "../../shared/builds/validation.js";
import { SiteBuildError } from "./errors.js";

/** Generated output lives under the product state directory, never alongside source projects. */
export class SiteBuildArtifacts {
  private readers = 0;
  constructor(private root: string) {}
  private file(id: string) {
    return join(this.root, buildId(id) + ".json");
  }
  private validate(value: unknown): BuildArtifact {
    let artifact: BuildArtifact;
    try {
      artifact = buildArtifact(value);
    } catch {
      throw new SiteBuildError("artifactDigestMismatch", 502);
    }
    for (const file of artifact.files)
      if (createHash("sha256").update(Buffer.from(file.data, "base64")).digest("hex") !== file.sha256)
        throw new SiteBuildError("artifactDigestMismatch", 502);
    return artifact;
  }
  async put(id: string, value: BuildArtifact) {
    const artifact = this.validate(value),
      file = this.file(id),
      temp = file + "." + randomUUID() + ".tmp";
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, JSON.stringify(artifact), { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
    return artifact;
  }
  async read(id: string) {
    try {
      return this.validate(JSON.parse(await readFile(this.file(id), "utf8")));
    } catch {
      throw new SiteBuildError("artifactUnavailable", 404);
    }
  }
  async remove(id: string) {
    await rm(this.file(id), { force: true });
  }
  async sweep(keep: ReadonlySet<string>) {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of files) {
      const match = /^([a-f0-9-]{36})\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.exec(name);
      if (!match) continue;
      const path = join(this.root, name);
      if (!name.endsWith(".tmp") && !keep.has(match[1]!)) await rm(path, { force: true });
      else if (name.endsWith(".tmp") && Date.now() - (await stat(path)).mtimeMs > 3600000)
        await rm(path, { force: true });
    }
  }
  async download(id: string) {
    if (this.readers >= 2) throw new SiteBuildError("busy", 429);
    this.readers++;
    try {
      const artifact = await this.read(id),
        files: Zippable = {};
      for (const file of artifact.files) files[file.path] = [Buffer.from(file.data, "base64"), { level: 0 }];
      return await new Promise<Uint8Array>((resolve, reject) =>
        zip(files, { level: 0 }, (error, result) => (error ? reject(error) : resolve(result))),
      );
    } finally {
      this.readers--;
    }
  }
}
