import type { BuildArtifact } from "../../../shared/builds/contracts.js";
import type { SitePublicationPlan, PublicationReceipt } from "../../../shared/delivery/contracts.js";
import type { RemoteSite } from "../../../shared/connections/remote-files.js";
import type { PublicationGate } from "../ports.js";
import { DeliveryError } from "../errors.js";
import { remoteDirectory, verifyRemoteRelease } from "./remote-state.js";

async function capacity(site: RemoteSite, additional: number) {
  const root = site.path + "/releases";
  if (!(await site.files.stat(root))) return;
  let bytes = additional,
    entries = 0;
  const walk = async (path: string, depth: number) => {
    if (depth > 34) throw new DeliveryError("remoteTargetQuota", 507);
    await remoteDirectory(site.files, path);
    for (const item of await site.files.list(path)) {
      if (++entries > 50000) throw new DeliveryError("remoteTargetQuota", 507);
      if (item.kind === "directory") await walk(path + "/" + item.name, depth + 1);
      else if (item.kind === "file") bytes += item.size;
      else throw new DeliveryError("remoteTargetChanged", 409);
      if (bytes > 512 * 1024 * 1024) throw new DeliveryError("remoteTargetQuota", 507);
    }
  };
  if ((await site.files.list(root)).length >= 50) throw new DeliveryError("remoteTargetQuota", 507);
  await walk(root, 0);
}
/** A release is immutable and invisible until a separate activation step switches current. */
export async function uploadRemoteRelease(
  site: RemoteSite,
  plan: SitePublicationPlan,
  artifact: BuildArtifact,
  previous: string | null,
  gate: PublicationGate,
): Promise<PublicationReceipt> {
  await capacity(site, artifact.bytes);
  const root = site.path + "/releases",
    release = root + "/" + plan.id;
  if (!(await site.files.stat(root)))
    await gate.remote("staging", "createReleases", () => site.files.mkdir(root, 0o755));
  await remoteDirectory(site.files, root);
  if (await site.files.stat(release)) throw new DeliveryError("remoteTargetChanged", 409);
  await gate.remote("staging", "createRelease", () => site.files.mkdir(release, 0o755));
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  await gate.remote("staging", "writeManifest", () =>
    site.files.write(release + "/manifest.json", encode({ id: plan.id, fingerprint: plan.fingerprint }), 0o600),
  );
  const directories = new Set<string>();
  for (const file of artifact.files) {
    let parent = release + "/site";
    for (const part of ["", ...file.path.split("/").slice(0, -1)]) {
      if (part) parent += "/" + part;
      if (!directories.has(parent)) {
        await gate.remote("staging", "createDirectory", () => site.files.mkdir(parent, 0o755));
        directories.add(parent);
      }
      await remoteDirectory(site.files, parent);
    }
    await gate.remote("staging", "uploadFile", () =>
      site.files.write(release + "/site/" + file.path, Buffer.from(file.data, "base64"), 0o644),
    );
  }
  const receipt: PublicationReceipt = {
    verification: "sftp-files",
    releaseId: plan.id,
    fingerprint: plan.fingerprint,
    publicUrl: plan.connection.publicUrl,
    servedPath: plan.servedPath,
    previousRelease: previous,
    publishedAt: Date.now(),
  };
  await gate.remote("staging", "writeReceipt", () =>
    site.files.write(release + "/receipt.json", encode(receipt), 0o600),
  );
  await verifyRemoteRelease(site, plan, artifact);
  return receipt;
}
