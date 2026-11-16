import { createHash } from "node:crypto";
import sharp from "sharp";
import { isRecord } from "../../shared/records.js";
import { BotError } from "../../shared/bots/contracts.js";

let normalizing = 0;
/** Decode a bounded local upload, strip metadata, and preserve no external resource references. */
export async function prepareBotProfile(owner: string, value: Record<string, unknown>) {
  const avatar = value.avatar;
  if (!isRecord(avatar) || avatar.type !== "upload") return { value };
  if (
    Object.keys(avatar).some((k) => !["type", "data"].includes(k)) ||
    typeof avatar.data !== "string" ||
    avatar.data.length > 400000
  )
    throw new BotError("invalidAvatar");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar.data);
  if (!match || normalizing >= 2) throw new BotError(match ? "avatarBusy" : "invalidAvatar", match ? 429 : 400);
  normalizing++;
  try {
    const input = Buffer.from(match[2]!, "base64"),
      image = sharp(input, { limitInputPixels: 1048576, failOn: "warning" }),
      metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1)
      throw new BotError("invalidAvatar");
    const bytes = await image.rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
    if (bytes.length > 65536) throw new BotError("invalidAvatar");
    const id = createHash("sha256")
      .update(owner + ":")
      .update(bytes)
      .digest("hex");
    return { value: { ...value, avatar: { type: "image", id } }, image: { id, bytes } };
  } catch (error) {
    if (error instanceof BotError) throw error;
    throw new BotError("invalidAvatar");
  } finally {
    normalizing--;
  }
}
