import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creationVideoProcess } from "../../creation/integration/rendering/video-process.js";
import { DocumentError } from "../../documents/errors.js";
import { creativeFileExtension } from "../../../shared/creative/file-types.js";

export async function renderVideoCover(source: Buffer, name: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "panda-video-cover-"));
  try {
    const frame = join(directory, "frame.png");
    await writeFile(join(directory, "source"), source, { mode: 0o600, signal });
    const webm = creativeFileExtension(name) === "webm";
    await creationVideoProcess(
      process.env.PANDA_FORCE_CREATION_FFMPEG || "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-max_alloc",
        "67108864",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-f",
        webm ? "matroska" : "mov",
        ...(webm ? [] : ["-enable_drefs", "0", "-use_absolute_path", "0"]),
        "-i",
        "source",
        "-map",
        "0:v:0",
        "-vf",
        "scale=512:320:force_original_aspect_ratio=decrease",
        "-frames:v",
        "1",
        "-c:v",
        "png",
        "-threads",
        "1",
        "-update",
        "1",
        "frame.png",
      ],
      { cwd: directory, signal, timeoutMs: 12000 },
    );
    const size = (await stat(frame)).size;
    if (!size || size > 1024 * 1024) throw new DocumentError("invalidInput");
    return await readFile(frame, { signal });
  } catch {
    throw new DocumentError("unavailable", 503);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
