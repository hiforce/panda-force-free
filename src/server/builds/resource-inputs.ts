import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ResourceBuildRequest } from "../../shared/builds/resources.js";
import { encodeResourceBuild, decodeResourceBuild, RESOURCE_FRAME_MAX } from "../../shared/builds/resource-frame.js";
import { buildId } from "../../shared/builds/validation.js";
import { FilePackageContent } from "../packages/content-store.js";
import { OwnedContentDirectories } from "../packages/content-directories.js";
import { LocalNamespaceActivity } from "../packages/namespace-activity.js";
import { SiteBuildError } from "./errors.js";
import type { BuildInputBudget, ResourceBuildInputs } from "./resource-input-port.js";
export const RESOURCE_INPUT_READ_BYTES = RESOURCE_FRAME_MAX * 4 + 128 * 1024 * 1024;
const unavailable = () => new SiteBuildError("snapshotUnavailable", 503);

/** Each persisted input owns an immutable directory. The creator holds its value allocation until write resolves. */
export class FileResourceBuildInputs implements ResourceBuildInputs {
  private directories: OwnedContentDirectories;
  private activity = new LocalNamespaceActivity(unavailable);
  constructor(
    root: string,
    private budget: BuildInputBudget,
  ) {
    this.directories = new OwnedContentDirectories(root, unavailable);
  }
  private content(id: string) {
    return new FilePackageContent<ResourceBuildRequest>(
      this.directories.path(buildId(id)),
      {
        maxBytes: RESOURCE_FRAME_MAX,
        extension: ".build",
        encode: async (value) => encodeResourceBuild(value),
        decode: decodeResourceBuild,
        digest: (value) => value.digest,
      },
      { createDirectory: false },
    );
  }
  prepare(id: string) {
    this.directories.prepare(buildId(id));
  }
  write(id: string, input: ResourceBuildRequest) {
    buildId(id);
    let bytes = 0;
    return this.activity
      .write(id, async () => {
        try {
          if (!(input instanceof ResourceBuildRequest)) throw unavailable();
          await this.content(id).put(input);
          const stat = await lstat(join(this.directories.path(id), input.digest + ".build"));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RESOURCE_FRAME_MAX) throw unavailable();
          bytes = stat.size;
        } catch {
          throw unavailable();
        }
      })
      .then(() => bytes);
  }
  with<T>(id: string, digest: string, use: (input: ResourceBuildRequest, bytes: number) => Promise<T>): Promise<T> {
    buildId(id);
    if (!/^[a-f0-9]{64}$/.test(digest)) return Promise.reject(unavailable());
    return this.activity.read(id, async () => {
      const lease = this.budget.acquire(RESOURCE_INPUT_READ_BYTES);
      if (!lease) throw new SiteBuildError("inputBusy", 429);
      try {
        let saved: { value: ResourceBuildRequest; bytes: number };
        try {
          saved = await this.content(id).readSized(digest);
          await this.directories.sync(id);
        } catch {
          throw unavailable();
        }
        return await use(saved.value, saved.bytes);
      } finally {
        lease.release();
      }
    });
  }
  remove(id: string) {
    buildId(id);
    return this.activity.remove(id, () => this.directories.remove(id));
  }
}
