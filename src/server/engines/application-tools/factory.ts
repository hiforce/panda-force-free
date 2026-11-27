import { mkdir, mkdtemp, lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { CodexConnection, CodexTransportFactory } from "../codex-transport.js";
import { createCodexApplicationEngine } from "./codex.js";
import { harnessOutputReader } from "../../harness/workspaces.js";
import { trackApplicationDirectory, registerApplicationRoot } from "./sessions.js";

export interface ApplicationEngineProfile {
  engineId: string;
  runtimeId?: string;
  model?: string;
  effort?: string;
  activeTimeoutMs?: number;
}

/** Scoped transports use disposable scratch unless the application supplies a verified persistent creation directory. */
export function isolatedApplicationEngines(
  options: {
    connection: CodexConnection;
    scratchRoot: string;
    workspaceRoot?: string;
    version: string;
    engineId: string;
    purpose: "creation" | "knowledge" | "editorial" | "project-memory";
    runtimes?: import("./runtime-port.js").ApplicationRuntimePort;
  },
  factory?: CodexTransportFactory,
) {
  if (!isAbsolute(options.scratchRoot)) throw new Error("Application scratch directory must be absolute");
  registerApplicationRoot(options.scratchRoot);
  if (options.workspaceRoot) {
    if (!isAbsolute(options.workspaceRoot) || options.purpose !== "creation")
      throw Error("Persistent application workspace unavailable");
    registerApplicationRoot(options.workspaceRoot);
  }
  return {
    select(profile: ApplicationEngineProfile, owner?: string) {
      if (
        !(profile.runtimeId && options.runtimes && owner) &&
        (profile.engineId !== "codex" || options.engineId !== "codex")
      )
        throw new Error("Application engine unavailable");
      return {
        id: profile.engineId,
        async run(...args: Parameters<ReturnType<typeof createCodexApplicationEngine>["run"]>) {
          const [input, callbacks] = args;
          callbacks.signal.throwIfAborted();
          await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
          const info = await lstat(options.scratchRoot);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Application scratch directory unavailable");
          const directory = callbacks.directory;
          let scratch: string;
          if (directory) {
            if (!options.workspaceRoot || !isAbsolute(directory.path))
              throw Error("Persistent application workspace unavailable");
            await directory.verify();
            const root = await realpath(options.workspaceRoot),
              suffix = relative(root, directory.path),
              stat = await lstat(directory.path);
            if (
              !suffix ||
              suffix === ".." ||
              suffix.startsWith(".." + sep) ||
              isAbsolute(suffix) ||
              !stat.isDirectory() ||
              stat.isSymbolicLink() ||
              (await realpath(directory.path)) !== directory.path
            )
              throw Error("Persistent application workspace unavailable");
            scratch = directory.path;
          } else scratch = await mkdtemp(join(options.scratchRoot, "run-"));
          const untrack = trackApplicationDirectory(scratch);
          try {
            callbacks.signal.throwIfAborted();
            if (options.purpose === "creation" && callbacks.nativeFiles)
              callbacks.nativeFiles(await harnessOutputReader(scratch));
            if (profile.runtimeId && options.runtimes && owner)
              return await options.runtimes.engine(owner, profile, scratch, options.purpose).run(input, callbacks);
            return await createCodexApplicationEngine(
              {
                connection: options.connection,
                scratchDirectory: scratch,
                version: options.version,
                model: profile.model,
                effort: profile.effort,
                timeoutMs: profile.activeTimeoutMs,
                purpose: options.purpose,
              },
              factory,
            ).run(input, callbacks);
          } finally {
            untrack();
            if (!directory) await rm(scratch, { recursive: true, force: true });
          }
        },
      };
    },
  };
}
