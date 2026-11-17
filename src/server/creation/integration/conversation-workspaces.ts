import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import type { CreationTaskSpec } from "../contracts.js";
import { CreationError } from "../contracts.js";
import type { CreationOutputTasks } from "../ports.js";
import type { CreationWorkspace, CreationWorkspaces } from "../workspaces.js";
import { creationId, creationRecord, creationText, creationUuid } from "../validation.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { stableJson } from "../../../shared/stable-json.js";
import { openCreationDirectory } from "./conversation-directory.js";
interface Binding {
  owner: string;
  taskId: string;
  projectId: string;
  conversationId: string;
}
const key = (owner: string, id: string) =>
  createHash("sha256")
    .update(stableJson([creationText(owner, 200), creationUuid(id)]))
    .digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function binding(value: unknown): Binding {
  const v = creationRecord(value, ["owner", "taskId", "projectId", "conversationId"]);
  return {
    owner: creationText(v.owner, 200),
    taskId: creationUuid(v.taskId),
    projectId: creationId(v.projectId),
    conversationId: creationUuid(v.conversationId),
  };
}
/** Immutable task lineage keeps all writing rounds in the original owned conversation directory. */
export class FileCreationWorkspaces implements CreationWorkspaces {
  private readonly bindings: FilePackageContent<Binding>;
  private readonly installations: FilePackageContent<{ id: string }>;
  constructor(
    private readonly root: string,
    metadataRoot: string,
    private readonly tasks: Pick<CreationOutputTasks, "get">,
    private readonly authorize: (owner: string, project: string) => Promise<void>,
  ) {
    this.installations = new FilePackageContent(metadataRoot + "-installation", {
      maxBytes: 1024,
      encode: async (v) => Buffer.from(stableJson(v)),
      decode: async (bytes) => {
        const v = creationRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["id"]);
        return { id: creationUuid(v.id) };
      },
      digest: () => createHash("sha256").update("creation-workspace-installation").digest("hex"),
    });
    this.bindings = new FilePackageContent(metadataRoot, {
      maxBytes: 8192,
      encode: async (v) => Buffer.from(stableJson(binding(v))),
      decode: async (bytes) => binding(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: (v) => key(v.owner, v.taskId),
    });
  }
  private async read(owner: string, id: string) {
    try {
      const v = await this.bindings.read(key(owner, id));
      if (v.owner !== owner || v.taskId !== id) throw new CreationError("notFound");
      return v;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  private async directory(v: Binding, create: boolean): Promise<CreationWorkspace | null> {
    await this.authorize(v.owner, v.projectId);
    const installationKey = createHash("sha256").update("creation-workspace-installation").digest("hex");
    if (create) await this.installations.put({ id: randomUUID() });
    let installation: { id: string };
    try {
      installation = await this.installations.read(installationKey);
    } catch (error) {
      if (!create && missing(error)) return null;
      throw error;
    }
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    let root: string;
    try {
      root = await realpath(this.root);
    } catch (error) {
      if (!create && missing(error)) return null;
      throw error;
    }
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CreationError("unavailable");
    const home = await openCreationDirectory(
      root,
      installation.id,
      { kind: "installation", installationId: installation.id },
      create,
    );
    if (!home) return null;
    const owner = await openCreationDirectory(
      home.path,
      createHash("sha256").update(v.owner).digest("hex"),
      { kind: "owner", owner: v.owner },
      create,
    );
    if (!owner) return null;
    const session = await openCreationDirectory(
      owner.path,
      v.conversationId,
      { kind: "conversation", owner: v.owner, projectId: v.projectId, conversationId: v.conversationId },
      create,
    );
    if (!session) return null;
    const verify = async () => {
      await this.authorize(v.owner, v.projectId);
      await home.verify();
      await owner.verify();
      await session.verify();
      await this.authorize(v.owner, v.projectId);
    };
    await verify();
    return { path: session.path, conversationId: v.conversationId, verify };
  }
  async lookup(owner: string, id: string) {
    const task = await this.tasks.get(owner, creationUuid(id));
    await this.authorize(owner, task.spec.projectId);
    const saved = await this.read(owner, id);
    if (!saved) return null;
    if (saved.projectId !== task.spec.projectId) throw new CreationError("notFound");
    return this.directory(saved, false);
  }
  async open(task: CreationTaskSpec) {
    const actor = creationText(task.owner, 200),
      id = creationUuid(task.id),
      project = creationId(task.projectId);
    await this.authorize(actor, project);
    let saved = await this.read(actor, id);
    if (!saved) {
      let current = task;
      let conversationId: string;
      const seen = new Set<string>();
      for (;;) {
        if (seen.has(current.id) || seen.size >= 1024 || current.owner !== actor || current.projectId !== project)
          throw new CreationError("conflict");
        seen.add(current.id);
        const known = await this.read(actor, current.id);
        if (known) {
          if (known.projectId !== project) throw new CreationError("conflict");
          conversationId = known.conversationId;
          break;
        }
        if (!current.previousTaskId) {
          conversationId = current.id;
          break;
        }
        current = (await this.tasks.get(actor, current.previousTaskId)).spec;
      }
      saved = { owner: actor, taskId: id, projectId: project, conversationId };
      await this.bindings.put(saved);
      const frozen = await this.bindings.read(key(actor, id));
      if (stableJson(frozen) !== stableJson(saved)) throw new CreationError("conflict");
    }
    if (saved.projectId !== project) throw new CreationError("conflict");
    const directory = await this.directory(saved, true);
    if (!directory) throw new CreationError("unavailable");
    return directory;
  }
}
