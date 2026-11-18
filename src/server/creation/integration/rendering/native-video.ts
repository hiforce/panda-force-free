import { mkdir, lstat, realpath, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import sharp from "sharp";
import { CreationError } from "../../contracts.js";
import { creationVideoProcess } from "./video-process.js";
import { creationVideoFrame } from "./video-frame.js";
import { creationVideoComposition, type CreationVideoScene } from "./video-composition.js";
import type { GeneratedOriginal } from "./generated-originals.js";

export const VIDEO_COMPOSITION_RESOURCE = "panda-video-composition.json";
export class NativeCreationVideoRenderer {
  private probe?: { expires: number; work: Promise<boolean> };
  private readonly root: string;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly family: string;
  constructor(
    root: string,
    env: NodeJS.ProcessEnv = process.env,
    private readonly readinessProbe: () => Promise<boolean> = () => this.check(),
  ) {
    this.root = resolve(root);
    this.ffmpeg = env.PANDA_FORCE_CREATION_FFMPEG || "ffmpeg";
    this.ffprobe = env.PANDA_FORCE_CREATION_FFPROBE || "ffprobe";
    this.family = env.PANDA_FORCE_CREATION_VIDEO_FONT_FAMILY || "Noto Sans CJK SC";
  }
  available() {
    if (this.probe && this.probe.expires > Date.now()) return this.probe.work;
    const work = this.probeReadiness().then((available) => {
      if (this.probe?.work === work) this.probe.expires = Date.now() + (available ? 30000 : 1000);
      return available;
    });
    this.probe = { expires: Infinity, work };
    return work;
  }
  private async probeReadiness() {
    // Local capability checks may briefly fail during startup; never retain that result for the successful cache period.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (await this.readinessProbe()) return true;
      } catch {
        // Each bounded probe owns and closes its children before a second attempt.
      }
    }
    return false;
  }
  private async check() {
    if (process.env.XDG_CACHE_HOME) {
      if (!isAbsolute(process.env.XDG_CACHE_HOME)) return false;
      await mkdir(join(process.env.XDG_CACHE_HOME, "fontconfig"), { recursive: true, mode: 0o700 });
    }
    if (
      [this.ffmpeg, this.ffprobe].some((p) => p.includes("/") && !isAbsolute(p)) ||
      !this.family.trim() ||
      this.family.length > 100 ||
      /[\p{Cc}\p{Cs}]/u.test(this.family)
    )
      return false;
    const options = { signal: new AbortController().signal, timeoutMs: 2500 },
      children = [
        creationVideoProcess(this.ffmpeg, ["-hide_banner", "-h", "encoder=libx264"], options),
        creationVideoProcess(this.ffmpeg, ["-hide_banner", "-filters"], options),
        creationVideoProcess(this.ffprobe, ["-version"], options),
        creationVideoProcess("fc-match", ["-f", "%{family}", this.family], options),
      ] as const,
      [encoder, filters, probe, font] = await Promise.all(children).finally(() => Promise.allSettled(children));
    if (
      !encoder.includes("Encoder libx264") ||
      !filters.includes("zoompan") ||
      !filters.includes("concat") ||
      !filters.includes("fade") ||
      !probe.startsWith("ffprobe version") ||
      !font.split(",").some((name) => name.trim().toLowerCase() === this.family.toLowerCase())
    )
      return false;
    await sharp({ text: { text: "计算机", font: this.family + " 24", rgba: true } })
      .png()
      .toBuffer();
    return true;
  }
  async render(
    value: unknown,
    context: {
      signal: AbortSignal;
      image(handle: string): Promise<Uint8Array>;
      authorize(): Promise<void>;
      originalImage?(name: string): Promise<Uint8Array>;
    },
  ): Promise<GeneratedOriginal> {
    const composition = creationVideoComposition(value);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(180000)]);
    context.signal.throwIfAborted();
    await context.authorize();
    if (!(await this.available())) throw new CreationError("unavailable");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(this.root)) !== this.root)
      throw new CreationError("unavailable");
    const directory = await mkdtemp(join(this.root, "render-")),
      resources: { name: string; bytes: Uint8Array }[] = [],
      portrait = composition.aspect === "portrait",
      width = portrait ? 720 : 1280,
      height = portrait ? 1280 : 720;
    try {
      const clips: string[] = [],
        stored: Omit<CreationVideoScene, "imageHandle">[] = [];
      for (const [index, scene] of composition.scenes.entries()) {
        signal.throwIfAborted();
        await context.authorize();
        let image: Uint8Array | undefined;
        if (scene.imageHandle) image = await context.image(scene.imageHandle);
        else if (scene.originalImage) {
          if (!context.originalImage) throw new CreationError("invalidInput");
          image = await context.originalImage(scene.originalImage);
        }
        const frame = await creationVideoFrame(
            scene,
            index,
            composition.scenes.length,
            composition.aspect,
            this.family,
            image,
          ),
          name = "frame-" + index + ".png";
        await writeFile(join(directory, name), frame, { flag: "wx", mode: 0o600 });
        const clip = "scene-" + index + ".mp4",
          filter = `zoompan=z='min(1.025,1+on*0.00004)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=24,fade=t=in:st=0:d=0.25,fade=t=out:st=${scene.duration - 0.25}:d=0.25`;
        await creationVideoProcess(
          this.ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-filter_threads",
            "1",
            "-threads",
            "1",
            "-loop",
            "1",
            "-framerate",
            "24",
            "-protocol_whitelist",
            "file",
            "-i",
            name,
            "-vf",
            filter,
            "-an",
            "-t",
            String(scene.duration),
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-fs",
            "33554432",
            "-n",
            clip,
          ],
          { cwd: directory, signal, timeoutMs: 180000, authorize: context.authorize },
        );
        clips.push(clip);
        const { imageHandle: _handle, originalImage: _original, ...content } = scene;
        if (image) {
          const name = "images/scene-" + index + ".png",
            bytes = await sharp(image, { limitInputPixels: 40_000_000 })
              .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
              .png()
              .toBuffer();
          if (bytes.length > 8 * 1024 * 1024) throw new CreationError("invalidInput");
          resources.push({ name, bytes });
          stored.push({ ...content, originalImage: name });
        } else stored.push(content);
      }
      const duration = composition.scenes.reduce((n, s) => n + s.duration, 0),
        output = "video.mp4";
      if (resources.reduce((n, r) => n + r.bytes.length, 0) > 32 * 1024 * 1024) throw new CreationError("invalidInput");
      let clipBytes = 0;
      for (const clip of clips) clipBytes += (await lstat(join(directory, clip))).size;
      if (clipBytes >= 32 * 1024 * 1024) throw new CreationError("invalidOutput");
      await writeFile(join(directory, "scenes.txt"), clips.map((clip) => "file '" + clip + "'").join("\n"), {
        flag: "wx",
        mode: 0o600,
      });
      await creationVideoProcess(
        this.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-protocol_whitelist",
          "file",
          "-f",
          "concat",
          "-safe",
          "1",
          "-i",
          "scenes.txt",
          "-map",
          "0:v:0",
          "-an",
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          "-fs",
          "33554432",
          "-n",
          output,
        ],
        { cwd: directory, signal, timeoutMs: 10000, authorize: context.authorize },
      );
      const measured = JSON.parse(
          await creationVideoProcess(
            this.ffprobe,
            [
              "-v",
              "error",
              "-protocol_whitelist",
              "file",
              "-show_entries",
              "stream=codec_name,codec_type,width,height,nb_frames:format=duration",
              "-of",
              "json",
              output,
            ],
            { cwd: directory, signal, timeoutMs: 10000, authorize: context.authorize },
          ),
        ),
        streams = measured.streams;
      if (
        !Array.isArray(streams) ||
        streams.length !== 1 ||
        streams[0].codec_type !== "video" ||
        streams[0].codec_name !== "h264" ||
        streams[0].width !== width ||
        streams[0].height !== height ||
        !Number.isFinite(Number(measured.format?.duration)) ||
        Math.abs(Number(measured.format?.duration) - duration) > 0.1 ||
        Number(streams[0].nb_frames) !== duration * 24
      )
        throw new CreationError("invalidOutput");
      const bytes = await readFile(join(directory, output));
      if (!bytes.length || bytes.length >= 32 * 1024 * 1024) throw new CreationError("invalidOutput");
      await context.authorize();
      signal.throwIfAborted();
      resources.push({
        name: VIDEO_COMPOSITION_RESOURCE,
        bytes: Buffer.from(
          JSON.stringify({ schema: 1, mode: "motion-graphics-silent", aspect: composition.aspect, scenes: stored }),
        ),
      });
      return { kind: "video", name: output, bytes, resources };
    } catch (error) {
      if (signal.aborted && !context.signal.aborted) throw new CreationError("unavailable");
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
