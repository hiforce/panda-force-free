import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, join, resolve, isAbsolute } from "node:path";
import { HarnessError, type HarnessConversation } from "../../shared/harness/contracts.js";
import type { CreationMaterialPort } from "../creation/materials.js";
import type { HarnessPrompt } from "./ports.js";
import type { HarnessPrincipal } from "./registry.js";
import { ensureAttachmentWorkspace } from "../workspace/attachment-workspace.js";
import { attachmentImageType, ATTACHMENT_MAX_BYTES } from "../workspace/attachments.js";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** Engine-neutral material resolution reuses owned upload authorization and stages only explicitly selected bytes. */
export class HarnessMaterials {
  constructor(
    private readonly options: {
      roots: readonly string[];
      allows(path: string): boolean;
      materials(): CreationMaterialPort;
      remote?(url: string): Promise<{ bytes: Uint8Array; canonicalUrl: string }>;
    },
  ) {}
  async resolve(
    principal: HarnessPrincipal,
    ids: readonly string[],
    conversation: HarnessConversation,
  ): Promise<HarnessPrompt["attachments"]> {
    if (!principal.administrator) throw new HarnessError("forbidden", 403);
    const result: HarnessPrompt["attachments"] = [];
    for (const id of ids) {
      let bytes: Uint8Array, name: string, url: string | undefined;
      if (id.startsWith("material:")) {
        const port = this.options.materials(),
          material = (await port.prepare(principal.owner, [{ materialId: id.slice(9) }]))[0];
        if (!material || !port.readOriginal) throw new HarnessError("notFound", 404);
        bytes = await port.readOriginal(principal.owner, material);
        name = material.name;
        url = `/api/chat-materials/original?id=${encodeURIComponent(material.id)}`;
      } else if (/^https:\/\//.test(id) && this.options.remote) {
        const value = await this.options.remote(id);
        bytes = value.bytes;
        url = value.canonicalUrl;
        name = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
      } else {
        if (
          !isAbsolute(id) ||
          !this.options.allows(id) ||
          !id.includes("/attachments/input/") ||
          (await realpath(id)) !== resolve(id)
        )
          throw new HarnessError("forbidden", 403);
        const file = await open(id, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await file.stat();
          if (!metadata.isFile() || metadata.size > ATTACHMENT_MAX_BYTES) throw new HarnessError("invalidInput", 413);
          bytes = await file.readFile();
        } finally {
          await file.close();
        }
        name = basename(id);
      }
      if (!bytes.length || bytes.length > ATTACHMENT_MAX_BYTES || basename(name) !== name || name.includes("\\"))
        throw new HarnessError("invalidInput", 413);
      const root = ensureAttachmentWorkspace(conversation.cwd, this.options.roots).input,
        folder = join(root, digest(id));
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if ((await realpath(folder)) !== folder) throw new HarnessError("forbidden", 403);
      const path = join(folder, name);
      let file: FileHandle | undefined;
      try {
        file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
      if (file) {
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
      } else {
        const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const metadata = await existing.stat();
          if (metadata.size !== bytes.length || digest(await existing.readFile()) !== digest(bytes))
            throw new HarnessError("conflict", 409);
        } finally {
          await existing.close();
        }
      }
      const mimeType = attachmentImageType(Buffer.from(bytes)) || "application/octet-stream";
      result.push({
        id,
        name,
        path,
        bytes: bytes.length,
        mimeType,
        kind: mimeType.startsWith("image/") ? "image" : "file",
        ...(url ? { url } : {}),
      });
    }
    return result;
  }
}
