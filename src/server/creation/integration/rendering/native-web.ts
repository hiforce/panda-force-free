import sharp from "sharp";
import { CreationError } from "../../contracts.js";
import { creationDigest, creationRecord } from "../../validation.js";
import { creativeResourceName } from "../../../creative/assets/codec.js";
import type { GeneratedOriginal } from "./generated-originals.js";

/** The original is actual HTML and owned resource bytes; online viewing keeps the existing isolated static preview. */
export async function renderCreationWeb(
  value: unknown,
  image: (handle: string) => Promise<Uint8Array>,
): Promise<GeneratedOriginal> {
  const row = creationRecord(value, ["html", "images"]),
    html = row.html,
    rawImages = row.images ?? [];
  if (
    typeof html !== "string" ||
    !html.trim() ||
    !html.includes("<") ||
    /[\0\p{Cs}]/u.test(html) ||
    Buffer.byteLength(html) > 2 * 1024 * 1024 ||
    !Array.isArray(rawImages) ||
    rawImages.length > 32
  )
    throw new CreationError("invalidInput");
  const captured = rawImages.map((value) => {
    const ref = creationRecord(value, ["name", "handle"]),
      name = creativeResourceName(ref.name);
    if (!/\.(png|jpe?g|webp)$/i.test(name) || name.toLowerCase() === "index.html")
      throw new CreationError("invalidInput");
    return { name, handle: creationDigest(ref.handle) };
  });
  if (new Set(captured.map((r) => r.name.toLowerCase())).size !== captured.length)
    throw new CreationError("invalidInput");
  const resources: { name: string; bytes: Buffer }[] = [];
  for (const ref of captured) {
    const source = await image(ref.handle),
      raster = sharp(source, { limitInputPixels: 40_000_000 }).resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      }),
      bytes = await (
        /\.png$/i.test(ref.name)
          ? raster.png()
          : /\.webp$/i.test(ref.name)
            ? raster.webp({ quality: 90 })
            : raster.jpeg({ quality: 90 })
      ).toBuffer();
    if (bytes.length > 8 * 1024 * 1024) throw new CreationError("invalidOutput");
    resources.push({ name: ref.name, bytes });
  }
  return { kind: "web", name: "index.html", bytes: Buffer.from(html), resources };
}
