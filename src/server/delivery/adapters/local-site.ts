import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mapMetadata } from "../../../shared/async-value.js";
import type { BuildArtifact } from "../../../shared/builds/contracts.js";
import type { PublicationReceipt, SitePublicationPlan } from "../../../shared/delivery/contracts.js";
import { DeliveryError } from "../errors.js";
import type { PublicationGate, SiteDeliveryAdapter } from "../ports.js";
import { digest } from "../validation.js";
import { durableLocalFile, syncLocalDirectories, syncLocalPath } from "./local-files.js";

function present(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function directory(path: string) {
  const info = present(path);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new DeliveryError("targetChanged", 409);
}
function smallJson(path: string) {
  const info = present(path);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 8192) throw new DeliveryError("targetChanged", 409);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new DeliveryError("targetChanged", 409);
  }
}

/** Files are staged under a dedicated connection root; only a fenced synchronous rename makes them visible. */
export class LocalSiteDelivery implements SiteDeliveryAdapter {
  constructor(
    private target: {
      claim(path: string, id: string): void | Promise<void>;
      assertOwned(path: string, id: string): void | Promise<void>;
    },
  ) {}
  private root(plan: SitePublicationPlan) {
    return dirname(plan.servedPath);
  }
  async reconcile(plan: SitePublicationPlan, artifact: BuildArtifact): Promise<PublicationReceipt | null> {
    const root = this.root(plan),
      release = join(root, "releases", plan.id);
    await this.target.assertOwned(root, plan.connectionId);
    if (this.current(root) !== plan.id) return null;
    await this.verify(release, plan, artifact);
    const receipt = smallJson(join(release, "receipt.json"));
    if (
      receipt.fingerprint !== plan.fingerprint ||
      receipt.publicUrl !== plan.connection.publicUrl ||
      receipt.servedPath !== plan.servedPath ||
      !Number.isSafeInteger(receipt.publishedAt)
    )
      throw new DeliveryError("targetChanged", 409);
    return receipt;
  }
  private current(root: string) {
    const file = join(root, "current"),
      info = present(file);
    if (!info) return null;
    if (!info.isSymbolicLink()) throw new DeliveryError("targetChanged", 409);
    const link = readlinkSync(file);
    if (!/^releases\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/site$/.test(link))
      throw new DeliveryError("targetChanged", 409);
    const id = link.split("/")[1]!,
      release = join(root, "releases", id);
    directory(release);
    directory(join(release, "site"));
    const manifest = smallJson(join(release, "manifest.json")),
      receipt = smallJson(join(release, "receipt.json"));
    if (
      manifest.id !== id ||
      receipt.releaseId !== id ||
      receipt.fingerprint !== manifest.fingerprint ||
      receipt.servedPath !== file
    )
      throw new DeliveryError("targetChanged", 409);
    return id;
  }
  private capacity(root: string, bytes: number) {
    let total = 0,
      count = 0;
    const walk = (path: string) => {
      for (const name of readdirSync(path)) {
        if (++count > 50000) throw new DeliveryError("targetQuota", 507);
        const file = join(path, name),
          info = present(file);
        if (!info) continue;
        if (info.isSymbolicLink()) throw new DeliveryError("targetChanged", 409);
        if (info.isDirectory()) walk(file);
        else if (info.isFile()) total += info.size;
        else throw new DeliveryError("targetChanged", 409);
        if (total + bytes > 512 * 1024 * 1024) throw new DeliveryError("targetQuota", 507);
      }
    };
    walk(root);
    if (readdirSync(root).length >= 50) throw new DeliveryError("targetQuota", 507);
  }
  private async verify(release: string, plan: SitePublicationPlan, artifact: BuildArtifact) {
    directory(release);
    directory(join(release, "site"));
    const manifest = smallJson(join(release, "manifest.json"));
    if (manifest.id !== plan.id || manifest.fingerprint !== plan.fingerprint)
      throw new DeliveryError("targetChanged", 409);
    const expected = new Set(artifact.files.map((file) => file.path));
    let found = 0;
    const walk = (base: string, prefix: string) => {
      for (const name of readdirSync(base)) {
        const path = join(base, name),
          info = lstatSync(path),
          key = prefix + name;
        if (info.isSymbolicLink()) throw new DeliveryError("targetChanged", 409);
        if (info.isDirectory()) walk(path, key + "/");
        else if (!info.isFile() || !expected.has(key) || ++found > artifact.files.length)
          throw new DeliveryError("targetChanged", 409);
      }
    };
    walk(join(release, "site"), "");
    if (found !== artifact.files.length) throw new DeliveryError("targetChanged", 409);
    for (const file of artifact.files) {
      const path = join(release, "site", file.path);
      if (lstatSync(path).size > 64 * 1024 * 1024 || digest(await readFile(path)) !== file.sha256)
        throw new DeliveryError("artifactInvalid", 409);
    }
  }
  async deliver(
    plan: SitePublicationPlan,
    artifact: BuildArtifact,
    gate: PublicationGate,
  ): Promise<PublicationReceipt> {
    const root = this.root(plan),
      releases = join(root, "releases"),
      release = join(releases, plan.id);
    await gate.run("staging", () =>
      mapMetadata(this.target.claim(root, plan.connectionId), () => {
        directory(releases);
        mkdirSync(releases, { recursive: true, mode: 0o755 });
      }),
    );
    if (!present(release)) {
      const stage = join(releases, `.stage-${plan.id}-${gate.fence}-${randomUUID()}`);
      await gate.run("staging", () => {
        this.capacity(releases, artifact.bytes);
        mkdirSync(stage, { mode: 0o755 });
      });
      try {
        const directories = new Set<string>([stage]);
        for (const file of artifact.files) {
          const path = join(stage, "site", file.path);
          await mkdir(dirname(path), { recursive: true, mode: 0o755 });
          for (let parent = dirname(path); parent !== stage; parent = dirname(parent)) directories.add(parent);
          await durableLocalFile(path, Buffer.from(file.data, "base64"), 0o644);
        }
        await durableLocalFile(
          join(stage, "manifest.json"),
          JSON.stringify({ id: plan.id, fingerprint: plan.fingerprint }),
          0o600,
        );
        await syncLocalDirectories(directories);
        await gate.run("staging", () =>
          mapMetadata(this.target.assertOwned(root, plan.connectionId), () => {
            directory(releases);
            if (!present(release)) {
              renameSync(stage, release);
              syncLocalPath(releases);
            }
          }),
        );
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    await this.verify(release, plan, artifact);
    return gate.run("activating", () =>
      mapMetadata(this.target.assertOwned(root, plan.connectionId), () => {
        directory(releases);
        directory(release);
        const current = this.current(root),
          intent = join(release, "receipt.json");
        let receipt: PublicationReceipt;
        if (present(intent)) {
          receipt = smallJson(intent);
          if (
            receipt.releaseId !== plan.id ||
            receipt.fingerprint !== plan.fingerprint ||
            receipt.servedPath !== plan.servedPath ||
            receipt.publicUrl !== plan.connection.publicUrl ||
            !Number.isSafeInteger(receipt.publishedAt) ||
            (receipt.previousRelease !== null && !/^[a-f0-9-]{36}$/.test(receipt.previousRelease))
          )
            throw new DeliveryError("targetChanged", 409);
        } else {
          if (current === plan.id) throw new DeliveryError("targetChanged", 409);
          receipt = {
            verification: "local-files",
            releaseId: plan.id,
            fingerprint: plan.fingerprint,
            publicUrl: plan.connection.publicUrl,
            servedPath: plan.servedPath,
            previousRelease: current,
            publishedAt: Date.now(),
          };
          writeFileSync(intent, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
          syncLocalPath(intent);
          syncLocalPath(release);
        }
        if (current === plan.id) return receipt;
        if (current !== receipt.previousRelease) throw new DeliveryError("targetChanged", 409);
        const next = join(root, ".current-" + randomUUID());
        try {
          symlinkSync(`releases/${plan.id}/site`, next);
          renameSync(next, join(root, "current"));
          syncLocalPath(root);
        } finally {
          if (present(next)) unlinkSync(next);
        }
        return receipt;
      }),
    );
  }
}
