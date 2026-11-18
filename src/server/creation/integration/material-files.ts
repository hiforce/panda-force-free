import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import type { CreationMaterial } from "../../../shared/creation/contracts.js";
import type { Route, RouteContext } from "../../http/router.js";
import type { ApplicationToolResult } from "../../../shared/engine/application-tools.js";
import { creationProtection } from "./protect.js";
import { CreationError } from "../contracts.js";
import { creationDigest, creationRecord, creationText, creationUuid } from "../validation.js";
import { saveAttachment } from "../../workspace/attachments.js";
import { respondJson } from "../../http/respond.js";
import type { CreationMaterialPort } from "../materials.js";
import { creationAttachments } from "../requests.js";
import { MaterialTextWorkers } from "../../materials/workers.js";
import { MATERIAL_TEXT_LIMITS, MaterialTextError } from "../../materials/contracts.js";
import { serverTranslator } from "../../i18n/messages.js";

const failureMessages = {
  unsupported: "creation.materialUnsupported",
  unreadable: "creation.materialUnreadable",
  empty: "creation.materialEmpty",
  encrypted: "creation.materialEncrypted",
  tooLarge: "creation.materialTooLarge",
  busy: "creation.materialBusy",
} as const;

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Upload receipts bind immutable source bytes to their authenticated owner, never to caller-supplied paths or URLs. */
export class FileCreationMaterials implements CreationMaterialPort {
  private readonly textWorkers = new MaterialTextWorkers();
  constructor(private readonly root: string) {}
  close() {
    return this.textWorkers.close();
  }
  private ownerRoot(owner: string) {
    return join(this.root, digest(Buffer.from(creationText(owner, 200))));
  }
  private async metadata(owner: string, id: string) {
    const bytes = await readFile(join(this.ownerRoot(owner), "index", creationUuid(id) + ".json"));
    if (bytes.length > 4096) throw new CreationError("notFound");
    const value = creationRecord(JSON.parse(bytes.toString("utf8")), ["id", "name", "kind", "digest"]);
    const material: CreationMaterial = {
      id: creationUuid(value.id),
      name: creationText(value.name, 240),
      kind: value.kind === "image" ? "image" : "file",
      digest: creationDigest(value.digest),
    };
    if (material.id !== id || basename(material.name) !== material.name || material.name.includes("\\"))
      throw new CreationError("notFound");
    return material;
  }
  private async original(owner: string, material: CreationMaterial) {
    const saved = await this.metadata(owner, material.id);
    if (JSON.stringify(saved) !== JSON.stringify(material)) throw new CreationError("conflict");
    const path = join(this.ownerRoot(owner), "data", material.id, material.name),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 25 * 1024 * 1024) throw new CreationError("notFound");
    const bytes = await readFile(path);
    if (digest(bytes) !== material.digest) throw new CreationError("conflict");
    return bytes;
  }
  async prepare(owner: string, value: unknown) {
    const refs = creationAttachments(value),
      result: CreationMaterial[] = [];
    for (const ref of refs) {
      try {
        const material = await this.metadata(owner, ref.materialId);
        await this.original(owner, material);
        result.push(material);
      } catch {
        throw new CreationError("notFound");
      }
    }
    return result;
  }
  async read(owner: string, material: CreationMaterial, offset = 0, locale = "en"): Promise<ApplicationToolResult> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new CreationError("invalidInput");
    const bytes = await this.original(owner, material);
    if (material.kind === "image") {
      const { attachmentImageType } = await import("../../workspace/attachments.js"),
        mime = attachmentImageType(bytes);
      if (!mime) throw new CreationError("invalidInput");
      return {
        success: true,
        text: JSON.stringify({ name: material.name, kind: "image" }),
        images: [`data:${mime};base64,${bytes.toString("base64")}`],
      };
    }
    let text: string, sections: number | undefined;
    try {
      if (/\.(pdf|docx|xlsx|pptx)$/i.test(extname(material.name))) {
        const result = await this.textWorkers.read(material.name, bytes);
        text = result.text;
        sections = result.sections;
      } else {
        if (!/\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|yaml|yml|log|sql)$/i.test(extname(material.name)))
          throw new MaterialTextError("unsupported");
        if (bytes.length > MATERIAL_TEXT_LIMITS.textBytes) throw new MaterialTextError("tooLarge");
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) throw new MaterialTextError("unreadable");
        if (!text.trim()) throw new MaterialTextError("empty");
      }
    } catch (error) {
      const code = error instanceof MaterialTextError ? error.code : "unreadable",
        messageId = failureMessages[code];
      return {
        success: false,
        text: JSON.stringify({
          messageId,
          message: serverTranslator(locale)(messageId),
          code,
          retryable: code === "busy",
          name: material.name,
        }),
      };
    }
    if (offset > text.length) throw new CreationError("invalidInput");
    let end = Math.min(offset + 4000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    const content = text.slice(offset, end);
    return {
      success: true,
      text: JSON.stringify({
        name: material.name,
        content,
        offset,
        length: text.length,
        ...(sections === undefined ? {} : { sections }),
        nextOffset: offset + content.length < text.length ? offset + content.length : null,
      }),
    };
  }
  async readOriginal(owner: string, material: CreationMaterial): Promise<Uint8Array> {
    return new Uint8Array(await this.original(owner, material));
  }
  routes(owner: (context: RouteContext) => string): Route[] {
    const protect = creationProtection(owner);
    return [
      {
        path: "/api/creation-materials",
        method: "POST",
        handler: protect(async ({ req, url, res }, actor) => {
          if ([...url.searchParams.keys()].some((key) => key !== "name")) throw new CreationError("invalidInput");
          const root = this.ownerRoot(actor),
            attachment = await saveAttachment(req, join(root, "data"), url.searchParams.get("name"));
          if (!("path" in attachment)) throw new CreationError("unavailable");
          const material: CreationMaterial = {
            id: attachment.id,
            name: attachment.name,
            kind: attachment.kind as "image" | "file",
            digest: digest(await readFile(attachment.path)),
          };
          await mkdir(join(root, "index"), { recursive: true, mode: 0o700 });
          await writeFile(join(root, "index", material.id + ".json"), JSON.stringify(material), {
            flag: "wx",
            mode: 0o600,
          });
          respondJson(res, 201, {
            attachment: {
              id: material.id,
              materialId: material.id,
              name: material.name,
              kind: material.kind,
              status: "ready",
              url: "/api/creation-materials/original?id=" + material.id,
            },
          });
        }),
      },
      {
        path: "/api/creation-materials/original",
        method: ["GET", "HEAD"],
        handler: protect(async ({ req, url, res }, actor) => {
          if (url.searchParams.getAll("id").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "id"))
            throw new CreationError("invalidInput");
          let material: CreationMaterial, bytes: Buffer;
          try {
            material = await this.metadata(actor, creationUuid(url.searchParams.get("id")));
            bytes = await this.original(actor, material);
          } catch {
            throw new CreationError("notFound");
          }
          const { attachmentImageType } = await import("../../workspace/attachments.js");
          res.writeHead(200, {
            "content-type":
              material.kind === "image"
                ? attachmentImageType(bytes) || "application/octet-stream"
                : "application/octet-stream",
            "content-length": bytes.length,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-disposition": `${material.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(material.name)}`,
          });
          res.end(req.method === "HEAD" ? undefined : bytes);
        }),
      },
    ];
  }
}
