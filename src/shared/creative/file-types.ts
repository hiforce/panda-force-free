import type { CreativeAssetKind } from "./assets.js";

export type CreativePreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "download";
const images: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};
const videos: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
};
const audio: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
};
const mime = (types: Readonly<Record<string, string>>, extension: string) =>
  Object.hasOwn(types, extension) ? types[extension] : undefined;
export const creativeFileExtension = (name: string) => name.toLowerCase().split(".").at(-1) ?? "";
export function creativeImportKind(name: string): CreativeAssetKind {
  const extension = creativeFileExtension(name);
  return extension === "pptx"
    ? "slides"
    : ["html", "zip"].includes(extension)
      ? "web"
      : mime(images, extension)
        ? "image"
        : mime(videos, extension)
          ? "video"
          : "file";
}
/** Only passive formats can be served inline. Authored HTML retains its separate isolated preview. */
export function creativeFilePreview(name: string): { kind: CreativePreviewKind; mime: string } {
  const extension = creativeFileExtension(name);
  const image = mime(images, extension),
    video = mime(videos, extension),
    sound = mime(audio, extension);
  if (image) return { kind: "image", mime: image };
  if (video) return { kind: "video", mime: video };
  if (sound) return { kind: "audio", mime: sound };
  if (extension === "pdf") return { kind: "pdf", mime: "application/pdf" };
  if (["txt", "md", "csv", "json", "log", "yaml", "yml", "xml"].includes(extension))
    return { kind: "text", mime: "text/plain; charset=utf-8" };
  return { kind: "download", mime: "application/octet-stream" };
}
export function creativeKindMatchesName(kind: CreativeAssetKind, name: string) {
  if (kind === "web") return creativeFileExtension(name) === "html";
  if (kind === "slides") return creativeFileExtension(name) === "pptx";
  if (kind === "image" || kind === "video") return creativeFilePreview(name).kind === kind;
  return true;
}
export const creativeKindMessages = {
  slides: "creative.slides",
  web: "creative.web",
  image: "creative.image",
  video: "creative.video",
  file: "creative.file",
} as const;
export const creativeKindIcons = {
  slides: "monitor",
  web: "globe",
  image: "image",
  video: "play",
  file: "file",
} as const;
