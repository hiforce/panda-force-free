import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { CreationError, CreationWriteError, type CreationTaskSpec } from "../contracts.js";
import type { CreationInputs } from "../input.js";
import type { CreationArtifactWriter, CreationOutputContent, CreationOutputTasks } from "../ports.js";
import type { CreationWorkspaces } from "../workspaces.js";
import { richDocumentInput } from "../../documents/rich-codec.js";
import { attachmentImageType } from "../../workspace/attachments.js";
import { CreationFileLocations, type CreationLocatedFile } from "./file-locations.js";
import { CreationAuthoredFileVersions } from "./authored-file-versions.js";
import { creationDocumentFilename, type CreationFileDirectory } from "./authored-files.js";
import { authoredMarkdown } from "./authored-markdown.js";
import { writeWorkspaceImages } from "./workspace-images.js";
import { CreationFileRelocations } from "./file-relocation.js";
import type { CreationFileDirectories } from "../file-directories.js";
import {
  creationWorkspaceExports,
  workspaceExportHash,
  type CreationWorkspaceExport,
} from "./workspace-export-plan.js";
import type { CreationDocumentPort } from "./document-port.js";

/** A primary write completes only after its portable source is durable in the verified conversation directory. */
export class CreationWorkspaceOutput implements CreationOutputContent, CreationArtifactWriter {
  private readonly plans: ReturnType<typeof creationWorkspaceExports>;
  private readonly versions: CreationAuthoredFileVersions;
  private readonly relocations: CreationFileRelocations;
  private readonly locations: CreationFileLocations;
  constructor(
    private readonly root: string,
    private readonly content: CreationOutputContent & {
      read(digest: string): Promise<{
        title: string;
        body: import("../../../shared/documents/rich-body.js").RichDocumentBody;
        fileDirectory?: string;
      }>;
      resolveTarget?(task: CreationTaskSpec): Promise<CreationTaskSpec>;
    },
    private readonly primary: CreationArtifactWriter,
    private readonly workspaces: CreationWorkspaces,
    private readonly inputs: CreationInputs,
    private readonly tasks: Pick<CreationOutputTasks, "get">,
    private readonly documentImages?: CreationDocumentPort["images"],
    private readonly directories?: CreationFileDirectories,
  ) {
    this.plans = creationWorkspaceExports(root);
    this.locations = new CreationFileLocations(join(root, "locations"));
    this.versions = new CreationAuthoredFileVersions(join(root, "versions"));
    this.relocations = new CreationFileRelocations(join(root, "relocations"));
  }
  async stage(value: unknown, task?: CreationTaskSpec) {
    if (!task) throw new CreationError("invalidInput");
    const digest = await this.content.stage(value, task);
    try {
      await this.prepare(task, digest);
    } catch (error) {
      if (error instanceof CreationError && ["conflict", "invalidInput"].includes(error.code))
        throw new CreationWriteError("fileChanged", error);
      if (error instanceof CreationError && error.code === "notFound")
        throw new CreationWriteError("targetChanged", error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CreationWriteError("targetChanged", error);
      throw error;
    }
    return digest;
  }
  private async previous(task: CreationTaskSpec): Promise<CreationLocatedFile | null> {
    let id = task.previousTaskId;
    const visited = new Set<string>([task.id]);
    while (id) {
      if (visited.has(id) || visited.size > 1024) throw new CreationError("conflict");
      visited.add(id);
      const prior = await this.tasks.get(task.owner, id);
      if (prior.spec.owner !== task.owner || prior.spec.projectId !== task.projectId)
        throw new CreationError("notFound");
      const receipt = await this.versions.receipt(task.owner, id);
      if (receipt) return receipt;
      id = prior.spec.previousTaskId;
    }
    return null;
  }
  private async prepare(task: CreationTaskSpec, digest: string): Promise<CreationWorkspaceExport> {
    const existing = await this.plans.read(task.owner, task.id, digest);
    if (existing) return existing;
    const workspace = await this.workspaces.open(task),
      source = await this.content.read(digest),
      target = this.content.resolveTarget ? await this.content.resolveTarget(task) : task,
      input = await this.inputs.read(task),
      lineage = input.documentFileLineage ?? workspace.conversationId,
      located = await this.locations.current(task.owner, lineage),
      title = task.previousTaskId && input.previous ? input.previous.document.title : source.title,
      imageIds = richDocumentInput(source.body).images,
      folder = "creation-assets-" + workspace.conversationId,
      paths = new Map<string, string>(),
      images: CreationWorkspaceExport["images"] = [];
    let previous: CreationLocatedFile | null = located ?? (input.previousAsset ? null : await this.previous(task));
    const directory = previous
      ? await this.directory(task, workspace, previous.directory, previous.directoryIdentity)
      : workspace;
    if (previous) {
      try {
        await this.versions.current(task.owner, previous.id, directory);
      } catch (error) {
        if (located || !(error instanceof CreationError) || error.code !== "conflict") throw error;
        previous = await this.versions.discover(task.owner, previous, directory);
      }
      if (!located) await this.locations.advance(task.owner, lineage, null, previous);
    }
    const archive =
      source.fileDirectory === undefined ? null : await this.directories?.open(task, source.fileDirectory);
    if (source.fileDirectory !== undefined && !archive) throw new CreationError("invalidOutput");
    if (archive && archive.path !== directory.path) {
      const filename = previous?.filename ?? creationDocumentFilename(title, lineage);
      try {
        await lstat(join(archive.path, filename));
        throw new CreationError("conflict");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await archive.verify();
    }
    for (const id of imageIds) {
      if (!target.target.document || !this.documentImages) throw new CreationError("unavailable");
      const bytes = await this.documentImages.read(
          task.owner,
          target.target.documentProjectId ?? task.projectId,
          target.target.document.documentId,
          id,
        ),
        type = attachmentImageType(Buffer.from(bytes)),
        extension =
          type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : null;
      if (!extension) throw new CreationError("invalidOutput");
      const hash = workspaceExportHash(bytes);
      await this.plans.images.put(bytes);
      if (!images.some((image) => image.digest === hash)) images.push({ digest: hash, extension });
      paths.set(id, folder + "/" + hash + "." + extension);
    }
    await workspace.verify();
    return this.plans.put({
      schema: 1,
      owner: task.owner,
      taskId: task.id,
      outputDigest: digest,
      directory: directory.path,
      ...(previous?.directoryIdentity ? { directoryIdentity: previous.directoryIdentity } : {}),
      ...(archive && archive.path !== directory.path
        ? { archiveDirectory: archive.path, archiveDirectoryIdentity: archive.identity }
        : {}),
      conversationId: workspace.conversationId,
      ...(input.documentFileLineage ? { lineageId: input.documentFileLineage } : {}),
      filename: previous?.filename ?? creationDocumentFilename(title, lineage),
      previous: previous?.id ?? null,
      title,
      markdown: authoredMarkdown(title, source.body, paths),
      images,
    });
  }
  private async directory(
    task: CreationTaskSpec,
    workspace: import("../workspaces.js").CreationWorkspace,
    path: string,
    identity?: string,
  ) {
    if (path === workspace.path) return workspace;
    const directory = await this.directories?.open(task, path);
    if (!directory || directory.identity !== identity) throw new CreationError("conflict");
    return directory;
  }
  async location(task: CreationTaskSpec) {
    const workspace = await this.workspaces.lookup(task.owner, task.id);
    if (!workspace) return null;
    const input = await this.inputs.read(task),
      current = await this.locations.current(task.owner, input.documentFileLineage ?? workspace.conversationId);
    if (!current) return null;
    const directory = await this.directory(task, workspace, current.directory, current.directoryIdentity);
    await directory.verify();
    return { path: join(current.directory, current.filename), format: "markdown" as const };
  }
  async commit(task: CreationTaskSpec, digest: string) {
    try {
      const plan = await this.prepare(task, digest),
        workspace = await this.workspaces.open(task);
      if (workspace.conversationId !== plan.conversationId) throw new CreationError("conflict");
      const directory = await this.directory(task, workspace, plan.directory, plan.directoryIdentity),
        destination = plan.archiveDirectory ? await this.directories?.open(task, plan.archiveDirectory) : null;
      if (plan.archiveDirectory && (!destination || destination.identity !== plan.archiveDirectoryIdentity))
        throw new CreationError("conflict");
      await workspace.verify();
      const artifact = await this.primary.commit(task, digest);
      if (artifact.kind !== "document") throw new CreationError("invalidOutput");
      if (artifact.title && artifact.title !== plan.title) throw new CreationError("conflict");
      const images = (target: CreationFileDirectory) =>
        writeWorkspaceImages(this.root, task, plan, target, workspace.path, (id) => this.plans.images.read(id));
      await images(directory);
      const version = await this.versions.write(
        task.owner,
        task.id,
        directory,
        plan.filename,
        plan.markdown,
        plan.previous ?? undefined,
      );
      await this.locations.advance(task.owner, plan.lineageId ?? workspace.conversationId, plan.previous, {
        ...version,
        ...(plan.directoryIdentity ? { directoryIdentity: plan.directoryIdentity } : {}),
      });
      const final = destination
        ? await this.relocations.commit({
            plan,
            version,
            source: directory,
            destination,
            versions: this.versions,
            locations: this.locations,
            images: () => images(destination),
          })
        : version;
      await workspace.verify();
      return { ...artifact, file: { path: join(final.directory, final.filename), format: "markdown" as const } };
    } catch (error) {
      if (error instanceof CreationWriteError) throw error;
      throw new CreationWriteError(
        error instanceof CreationError && error.code === "conflict" ? "fileChanged" : "writeUnavailable",
        error,
      );
    }
  }
}
