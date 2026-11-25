import { spawn } from "node:child_process";
import { existsSync, constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentError } from "../../documents/errors.js";

const maxPdfBytes = 32 * 1024 * 1024;
const local = new URL("./slides-sandbox.py", import.meta.url);
const entry = fileURLToPath(
  existsSync(local) ? local : new URL("../src/server/creative/assets/slides-sandbox.py", import.meta.url),
);
export interface RenderedSlideDeck {
  pdf: Buffer;
  pages: number;
}

function run(work: string, signal: AbortSignal, mode: "convert" | "info" | "page", page?: number) {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn("python3", [entry, mode, ...(page === undefined ? [] : [String(page)])], {
      cwd: work,
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: work,
        TMPDIR: work,
        XDG_CACHE_HOME: join(work, "cache"),
        PYTHONNOUSERSITE: "1",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process group may already have exited.
        }
      }
    };
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) stop();
      else chunks.push(chunk);
    });
    child.once("error", () => reject(new DocumentError("unavailable", 503)));
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      stop();
      if (code || code === null || signal.aborted || size > 16_384) reject(new DocumentError("unavailable", 503));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

async function isolatedWork<T>(action: (work: string) => Promise<T>) {
  const work = await mkdtemp(join(tmpdir(), "panda-slide-"));
  try {
    return await action(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function output(path: string, maximum: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > maximum) throw new DocumentError("unavailable", 503);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function renderSlideDeck(source: Uint8Array, signal: AbortSignal): Promise<RenderedSlideDeck> {
  return isolatedWork(async (work) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(32_000)]);
    await writeFile(join(work, "preview.pptx"), source, { mode: 0o600, flag: "wx", signal: deadline });
    await run(work, deadline, "convert");
    const pdf = await output(join(work, "preview.pdf"), maxPdfBytes);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new DocumentError("unavailable", 503);
    const pages = Number(/^Pages:\s+(\d+)$/m.exec(await run(work, deadline, "info"))?.[1]);
    if (!Number.isInteger(pages) || pages < 1 || pages > 500) throw new DocumentError("unavailable", 503);
    return { pdf, pages };
  });
}

export function rasterSlide(deck: RenderedSlideDeck, page: number, signal: AbortSignal) {
  return isolatedWork(async (work) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    await writeFile(join(work, "preview.pdf"), deck.pdf, { mode: 0o600, flag: "wx", signal: deadline });
    await run(work, deadline, "page", page);
    const bytes = await output(join(work, "page.png"), 9 * 1024 * 1024);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new DocumentError("unavailable", 503);
    return bytes;
  });
}
