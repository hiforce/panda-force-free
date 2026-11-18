import { CreationError } from "../../contracts.js";
import { creationDigest, creationInteger, creationRecord, creationText } from "../../validation.js";

export interface CreationVideoScene {
  duration: number;
  heading: string;
  text: string;
  imageHandle?: string;
  originalImage?: string;
}
export interface CreationVideoComposition {
  aspect: "landscape" | "portrait";
  scenes: CreationVideoScene[];
}
export function videoLines(text: string, width: number, maximum: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "",
      weight = 0;
    for (const letter of paragraph) {
      const next = letter.codePointAt(0)! > 255 ? 1 : 0.56;
      if (weight + next > width) {
        lines.push(line);
        line = "";
        weight = 0;
      }
      line += letter;
      weight += next;
    }
    lines.push(line);
  }
  if (lines.length > maximum) throw new CreationError("invalidInput");
  return lines;
}
export function creationVideoComposition(value: unknown): CreationVideoComposition {
  const row = creationRecord(value, ["aspect", "scenes"]),
    aspect = row.aspect ?? "landscape";
  if (
    !["landscape", "portrait"].includes(String(aspect)) ||
    !Array.isArray(row.scenes) ||
    !row.scenes.length ||
    row.scenes.length > 12
  )
    throw new CreationError("invalidInput");
  const scenes = row.scenes.map((scene) => {
    const r = creationRecord(scene, ["duration", "heading", "text", "imageHandle", "originalImage"]),
      duration = creationInteger(r.duration),
      heading = creationText(r.heading, 120),
      text = r.text ?? "";
    if (
      duration < 3 ||
      duration > 12 ||
      typeof text !== "string" ||
      text.length > 360 ||
      /[\p{Cc}\p{Cs}]/u.test(text.replace(/\n/g, "")) ||
      (r.imageHandle !== undefined && r.originalImage !== undefined)
    )
      throw new CreationError("invalidInput");
    const picture = r.imageHandle !== undefined || r.originalImage !== undefined;
    videoLines(heading, aspect === "portrait" ? 14 : picture ? 11 : 21, aspect === "portrait" ? 3 : 2);
    videoLines(text, aspect === "portrait" ? 15 : picture ? 14 : 32, aspect === "portrait" ? (picture ? 6 : 12) : 7);
    return {
      duration,
      heading,
      text,
      ...(r.imageHandle === undefined ? {} : { imageHandle: creationDigest(r.imageHandle) }),
      ...(r.originalImage === undefined ? {} : { originalImage: creationText(r.originalImage, 240) }),
    };
  });
  if (scenes.reduce((n, s) => n + s.duration, 0) > 90) throw new CreationError("invalidInput");
  return { aspect: aspect as CreationVideoComposition["aspect"], scenes };
}
