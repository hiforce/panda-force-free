import type { BuildArtifact } from "../../../shared/builds/contracts.js";
import type { SitePublicationPlan, PublicationReceipt } from "../../../shared/delivery/contracts.js";
import type { RemoteFiles, RemoteSite } from "../../../shared/connections/remote-files.js";
import { DeliveryError } from "../errors.js";
import { digest } from "../validation.js";

const id = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const releaseLink = new RegExp(`^releases/(${id})/site$`);
export const lockToken = (plan: SitePublicationPlan) => `plans/${plan.id}/${plan.fingerprint}`;
export async function remoteDirectory(files: RemoteFiles, path: string) {
  const info = await files.stat(path);
  if (!info || info.kind !== "directory" || (await files.realpath(path)) !== path)
    throw new DeliveryError("remoteTargetChanged", 409);
}
export async function remoteJson(files: RemoteFiles, path: string) {
  const bytes = await files.read(path, 8192);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DeliveryError("remoteTargetChanged", 409);
  }
}
export async function remoteLock(site: RemoteSite) {
  const path = site.path + "/.panda-publish.lock",
    info = await site.files.stat(path);
  if (!info) return null;
  if (info.kind !== "symlink") throw new DeliveryError("remoteTargetChanged", 409);
  return site.files.readlink(path);
}
export async function remoteCurrent(site: RemoteSite, servedPath: string) {
  await site.assertOwned();
  const info = await site.files.stat(site.path + "/current");
  if (!info) return null;
  if (info.kind !== "symlink") throw new DeliveryError("remoteTargetChanged", 409);
  const match = releaseLink.exec(await site.files.readlink(site.path + "/current"));
  if (!match) throw new DeliveryError("remoteTargetChanged", 409);
  const release = site.path + "/releases/" + match[1];
  for (const path of [site.path + "/releases", release, release + "/site"]) await remoteDirectory(site.files, path);
  const manifest = await remoteJson(site.files, release + "/manifest.json"),
    receipt = await remoteJson(site.files, release + "/receipt.json");
  if (
    manifest.id !== match[1] ||
    receipt.releaseId !== match[1] ||
    receipt.fingerprint !== manifest.fingerprint ||
    receipt.servedPath !== servedPath
  )
    throw new DeliveryError("remoteTargetChanged", 409);
  return match[1]!;
}
export async function verifyRemoteRelease(
  site: RemoteSite,
  plan: SitePublicationPlan,
  artifact: BuildArtifact,
): Promise<PublicationReceipt> {
  const release = site.path + "/releases/" + plan.id;
  await remoteDirectory(site.files, release);
  const manifest = await remoteJson(site.files, release + "/manifest.json");
  if (manifest.id !== plan.id || manifest.fingerprint !== plan.fingerprint)
    throw new DeliveryError("remoteTargetChanged", 409);
  const expected = new Set(artifact.files.map((file) => file.path));
  let found = 0,
    entries = 0;
  const walk = async (path: string, prefix: string, depth: number) => {
    if (depth > 32) throw new DeliveryError("remoteTargetChanged", 409);
    await remoteDirectory(site.files, path);
    for (const entry of await site.files.list(path)) {
      if (++entries > 10000) throw new DeliveryError("remoteTargetQuota", 507);
      if (entry.kind === "directory") await walk(path + "/" + entry.name, prefix + entry.name + "/", depth + 1);
      else if (entry.kind !== "file" || !expected.has(prefix + entry.name) || ++found > expected.size)
        throw new DeliveryError("remoteTargetChanged", 409);
    }
  };
  await walk(release + "/site", "", 0);
  if (found !== expected.size) throw new DeliveryError("remoteTargetChanged", 409);
  for (const file of artifact.files) {
    const bytes = await site.files.read(release + "/site/" + file.path, Buffer.byteLength(file.data, "base64"));
    if (digest(Buffer.from(bytes)) !== file.sha256) throw new DeliveryError("artifactInvalid", 409);
  }
  const receipt = await remoteJson(site.files, release + "/receipt.json");
  if (
    receipt.verification !== "sftp-files" ||
    receipt.releaseId !== plan.id ||
    receipt.fingerprint !== plan.fingerprint ||
    receipt.publicUrl !== plan.connection.publicUrl ||
    receipt.servedPath !== plan.servedPath ||
    !Number.isSafeInteger(receipt.publishedAt) ||
    receipt.publishedAt < 0 ||
    (receipt.previousRelease !== null && !new RegExp(`^${id}$`).test(receipt.previousRelease))
  )
    throw new DeliveryError("remoteTargetChanged", 409);
  return receipt;
}
