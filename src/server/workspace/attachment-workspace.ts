import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalRoots, inside } from "../path-utils.js";

/** Both the engine and HTTP service must mount the workspace at this same absolute path. */
export function ensureAttachmentWorkspace(cwd: string, allowedRoots: readonly string[], threadId?: string) {
  if (threadId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(threadId))
    throw new Error("Invalid attachment session id");
  const workspace = realpathSync(cwd);
  if (!lstatSync(workspace).isDirectory() || !canonicalRoots(allowedRoots).some((root) => inside(workspace, root)))
    throw new Error("Attachment workspace is outside allowed roots");
  function directory(parent: string, name: string) {
    const path = join(parent, name);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || !inside(realpathSync(path), workspace))
      throw new Error("Attachment directory must be a regular directory inside the workspace");
    return path;
  }
  const root = directory(workspace, "attachments");
  const marker = join(root, ".panda-attachments.json");
  if (!existsSync(marker)) {
    const temporary = mkdtempSync(join(root, ".panda-attachment-marker-"));
    try {
      const candidate = join(temporary, "marker.json");
      writeFileSync(
        candidate,
        JSON.stringify({ schema: 1, product: "PandaForce attachments", id: randomUUID() }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      try {
        // Publish complete bytes without replacing an identity created by another worker.
        linkSync(candidate, marker);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const metadata = lstatSync(marker);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 2048)
    throw new Error("Invalid attachment workspace marker");
  const identity: unknown = JSON.parse(readFileSync(marker, "utf8"));
  if (
    !identity ||
    typeof identity !== "object" ||
    !("schema" in identity) ||
    identity.schema !== 1 ||
    !("product" in identity) ||
    identity.product !== "PandaForce attachments" ||
    !("id" in identity) ||
    typeof identity.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(identity.id)
  )
    throw new Error("Invalid attachment workspace marker");
  const input = directory(root, "input");
  const work = directory(root, "work");
  const output = directory(root, "output");
  return {
    root,
    marker,
    markerId: identity.id,
    input,
    work: threadId === undefined ? work : directory(work, threadId),
    output: threadId === undefined ? output : directory(output, threadId),
  };
}
