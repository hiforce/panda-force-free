import sharp from "sharp";
import { escapeHtml } from "../../../../shared/html.js";
import type { CreationVideoScene } from "./video-composition.js";
import { CreationError } from "../../contracts.js";

/** Captions become bounded raster pixels; user text never becomes an FFmpeg expression or external SVG resource. */
export async function creationVideoFrame(
  scene: CreationVideoScene,
  index: number,
  total: number,
  aspect: string,
  family: string,
  image?: Uint8Array,
): Promise<Buffer> {
  const portrait = aspect === "portrait",
    width = portrait ? 720 : 1280,
    height = portrait ? 1280 : 720,
    headingSize = portrait ? 42 : 48,
    textSize = portrait ? 36 : 30,
    titleY = portrait ? 130 : 135,
    bodyY = portrait ? (image ? 790 : 370) : 325,
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#0B2033"/><path d="M64 54H${width - 64}" stroke="#294B62" stroke-width="3"/><path d="M64 54H${64 + ((width - 128) * (index + 1)) / total}" stroke="#73E4DD" stroke-width="7"/><g font-family="${escapeHtml(family)}"><text x="64" y="100" font-size="22" fill="#73E4DD">${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</text></g><circle cx="${width - 75}" cy="${height - 65}" r="14" fill="#73E4DD"/></svg>`;
  const canvas = sharp(Buffer.from(svg), { limitInputPixels: 2_000_000 });
  const layers: { input: Buffer; left: number; top: number }[] = [];
  for (const [text, top, size, color, maxHeight] of [
    [scene.heading, titleY, headingSize, "#F2F7FC", portrait ? 176 : 132],
    [scene.text, bodyY, textSize, "#C7D9E7", height - bodyY - 80],
  ] as const) {
    if (!text.trim()) continue;
    const tile = await sharp({
      text: {
        text: `<span foreground="${color}">${escapeHtml(text)}</span>`,
        font: family + " " + size,
        width: portrait ? 592 : image ? 560 : 1152,
        dpi: 72,
        rgba: true,
        spacing: Math.round(size * 0.3),
        wrap: "word-char",
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (tile.info.height > maxHeight) throw new CreationError("invalidInput");
    layers.push({ input: tile.data, left: 64, top });
  }
  if (image) {
    const imageWidth = portrait ? 592 : 500,
      imageHeight = portrait ? 380 : 460,
      picture = await sharp(image, { limitInputPixels: 40_000_000 })
        .resize(imageWidth, imageHeight, { fit: "contain", background: "#0B2033" })
        .png()
        .toBuffer();
    layers.push({ input: picture, left: portrait ? 64 : 716, top: portrait ? 350 : 150 });
  }
  return canvas.composite(layers).png().toBuffer();
}
