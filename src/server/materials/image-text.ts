import { spawn } from "node:child_process";
import sharp from "sharp";
import { creativeFileExtension } from "../../shared/creative/file-types.js";
import { attachmentImageType } from "../workspace/attachments.js";

export const imageTextRevision = 1;
const maxOutput = 512 * 1024;
const maxInput = 32 * 1024 * 1024;
const languages = ["eng", "chi_sim", "chi_tra"];
export const isRasterTextSource = (name: string) =>
  ["png", "jpg", "jpeg", "webp", "gif"].includes(creativeFileExtension(name));

function runTesseract(args: readonly string[], signal: AbortSignal, input?: Buffer): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn("tesseract", args, {
      stdio: [input ? "pipe" : "ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...(process.env.TESSDATA_PREFIX ? { TESSDATA_PREFIX: process.env.TESSDATA_PREFIX } : {}),
        LANG: "C.UTF-8",
        OMP_THREAD_LIMIT: "1",
      },
    });
    const stop = () => {
      child.kill("SIGKILL");
    };
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) stop();
      else chunks.push(chunk);
    });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      resolve(code === 0 && !signal.aborted && size <= maxOutput ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

interface Line {
  words: string[];
  confidence: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function lines(tsv: string, width: number, height: number) {
  const found = new Map<string, Line>();
  for (const row of tsv.split(/\r?\n/u)) {
    const columns = row.split("\t");
    const token = columns[11]?.trim();
    if (columns.length !== 12 || columns[0] !== "5" || !token || token.includes("\0")) continue;
    const [left, top, w, h, confidence] = columns.slice(6, 11).map(Number) as [number, number, number, number, number];
    const right = left + w,
      bottom = top + h;
    if (
      ![left, top, w, h].every(Number.isSafeInteger) ||
      left < 0 ||
      top < 0 ||
      w <= 0 ||
      h <= 0 ||
      right > width ||
      bottom > height ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100
    )
      continue;
    const key = columns.slice(1, 5).join(":");
    const existing = found.get(key);
    if (!existing) {
      if (found.size >= 128) continue;
      found.set(key, { words: [token], confidence, left, top, right, bottom });
      continue;
    }
    if (existing.words.length >= 64) continue;
    existing.words.push(token);
    existing.confidence += confidence;
    existing.left = Math.min(existing.left, left);
    existing.top = Math.min(existing.top, top);
    existing.right = Math.max(existing.right, right);
    existing.bottom = Math.max(existing.bottom, bottom);
  }
  return [...found.values()].flatMap((line) => {
    if (line.confidence / line.words.length < 55) return [];
    const x = line.left / width,
      y = line.top / height;
    return [
      {
        text: line.words.join(" ").replace(/(\p{Script=Han}) +(?=\p{Script=Han})/gu, "$1"),
        region: { x, y, width: line.right / width - x, height: line.bottom / height - y },
      },
    ];
  });
}

/** Tesseract only sees a bounded, sanitized raster. Its executable and languages are installation-owned. */
export class ImageTextRecognizer {
  private readonly stopping = new AbortController();
  private installed?: Promise<string | undefined>;

  language() {
    return (this.installed ??= runTesseract(
      ["--list-langs"],
      AbortSignal.any([this.stopping.signal, AbortSignal.timeout(3500)]),
    ).then((output) => {
      const supported = new Set(output?.split(/\r?\n/u).map((line) => line.trim()));
      return languages.filter((language) => supported.has(language)).join("+") || undefined;
    }));
  }

  async read(input: Buffer, language: string, locale?: string) {
    const abort = this.stopping.signal;
    abort.throwIfAborted();
    if (input.length > maxInput || !attachmentImageType(input)) return [];
    const sourceLocale = locale?.toLowerCase().split("-") ?? [];
    const available = language.split("+");
    if (sourceLocale[0] === "zh") {
      const hint = sourceLocale.slice(1).find((part) => ["hans", "hant", "cn", "sg", "hk", "tw", "mo"].includes(part));
      const preferred = hint && (["hans", "cn", "sg"].includes(hint) ? "chi_sim" : "chi_tra");
      if (preferred && available.includes(preferred))
        language = available.includes("eng") ? preferred + "+eng" : preferred;
    }
    try {
      const { data, info } = await sharp(input, { limitInputPixels: 32_000_000, failOn: "error" })
        .autoOrient()
        .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .greyscale()
        .png()
        .toBuffer({ resolveWithObject: true });
      const output = await runTesseract(
        ["stdin", "stdout", "-l", language, "--psm", "11", "tsv"],
        AbortSignal.any([abort, AbortSignal.timeout(12000)]),
        data,
      );
      abort.throwIfAborted();
      return output ? lines(output, info.width, info.height) : [];
    } catch (error) {
      if (abort.aborted) throw error;
      return [];
    }
  }

  close() {
    this.stopping.abort();
  }
}
