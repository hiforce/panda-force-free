import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CreationMediaCliRegistration } from "../../../../shared/creation/media-executors.js";
import { FilePackageContent } from "../../../packages/content-store.js";
import { MediaExecutorError } from "../../media-executors/contracts.js";
import { creationDigest, creationInteger, creationRecord, creationText } from "../../validation.js";
import { installedMediaCli } from "./cli-provider.js";

type CliPackage = ReturnType<typeof installedMediaCli> & { preRegistered: boolean };
type Approval = { id: string; revision: number; fingerprint: string };
const approvalKey = ({ id, revision }: Approval) =>
  createHash("sha256")
    .update(JSON.stringify([id, revision]))
    .digest("hex");

export class MediaCliRegistry {
  readonly packages: CliPackage[];
  private readonly approvals: FilePackageContent<Approval>;

  constructor(root: string, env: NodeJS.ProcessEnv) {
    const load = (value: string | undefined, preRegistered: boolean) => {
      const paths: unknown = JSON.parse(value || "[]");
      if (!Array.isArray(paths) || paths.length > 16) throw new MediaExecutorError("invalidInput");
      return paths.map((path) => ({
        ...installedMediaCli(creationText(path, 2048), preRegistered),
        preRegistered,
      }));
    };
    this.packages = [
      ...load(env.PANDA_FORCE_MEDIA_CLI_MANIFESTS, true),
      ...load(env.PANDA_FORCE_MEDIA_CLI_REGISTRATION_MANIFESTS, false),
    ];
    if (this.packages.length > 16) throw new MediaExecutorError("invalidInput");
    this.approvals = new FilePackageContent(join(root, "cli-registrations"), {
      maxBytes: 512,
      encode: async (value) => Buffer.from(JSON.stringify(value)),
      decode: async (bytes) => {
        const row = creationRecord(JSON.parse(Buffer.from(bytes).toString("utf8")), ["id", "revision", "fingerprint"]);
        return {
          id: creationText(row.id, 64),
          revision: creationInteger(row.revision),
          fingerprint: creationDigest(row.fingerprint),
        };
      },
      digest: approvalKey,
    });
  }

  private identity(item: CliPackage): Approval {
    return { id: item.preset.id, revision: item.preset.version, fingerprint: item.fingerprint };
  }

  private async receipt(item: CliPackage) {
    return this.approvals.read(approvalKey(this.identity(item))).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async registered(item: CliPackage) {
    return item.preRegistered || (await this.receipt(item))?.fingerprint === item.fingerprint;
  }

  async available(id: string) {
    const item = this.packages.find(({ preset }) => preset.id === id);
    return !item || this.registered(item);
  }

  async catalog(): Promise<CreationMediaCliRegistration[]> {
    return Promise.all(
      this.packages.map(async (item) => {
        const { id, name, kind, version: revision } = item.preset;
        return {
          id,
          name,
          kind,
          revision,
          version: item.version,
          sha256: item.sha256,
          fingerprint: item.fingerprint,
          registered: await this.registered(item),
        };
      }),
    );
  }

  private find(id: string, revision: number) {
    const item = this.packages.find(({ preset }) => preset.id === id);
    if (!item) throw new MediaExecutorError("notFound");
    if (item.preset.version !== revision) throw new MediaExecutorError("conflict");
    return item;
  }

  instructions(id: string, revision: number) {
    return this.find(id, revision).instructions;
  }

  async register(id: string, revision: number, fingerprint: string, signal: AbortSignal) {
    const item = this.find(id, revision);
    if (item.fingerprint !== fingerprint) throw new MediaExecutorError("conflict");
    if (item.preRegistered) return;
    const prior = await this.receipt(item);
    if (prior) {
      if (prior.fingerprint !== item.fingerprint) throw new MediaExecutorError("conflict");
      return;
    }
    await item.provider.verifyInstallation(AbortSignal.any([signal, AbortSignal.timeout(10000)]));
    signal.throwIfAborted();
    if (!(await this.approvals.insert(this.identity(item))) && !(await this.registered(item)))
      throw new MediaExecutorError("conflict");
  }
}
