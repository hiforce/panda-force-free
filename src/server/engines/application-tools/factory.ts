import { mkdir, mkdtemp, lstat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CodexConnection, CodexTransportFactory } from "../codex-transport.js";
import { createCodexApplicationEngine } from "./codex.js";
import { trackApplicationDirectory, registerApplicationRoot } from "./sessions.js";

export interface ApplicationEngineProfile {
  engineId: string;
  model?: string;
  activeTimeoutMs?: number;
}

/** A scoped application receives an empty scratch directory and one owned native transport per execution. */
export function isolatedApplicationEngines(
  options: {
    connection: CodexConnection;
    scratchRoot: string;
    version: string;
    engineId: string;
    purpose: "creation" | "knowledge";
  },
  factory?: CodexTransportFactory,
) {
  if (!isAbsolute(options.scratchRoot)) throw new Error("Application scratch directory must be absolute");
  registerApplicationRoot(options.scratchRoot);
  return {
    select(profile: ApplicationEngineProfile) {
      if (profile.engineId !== "codex" || options.engineId !== "codex")
        throw new Error("Application engine unavailable");
      return {
        id: "codex",
        async run(...args: Parameters<ReturnType<typeof createCodexApplicationEngine>["run"]>) {
          const [input, callbacks] = args;
          callbacks.signal.throwIfAborted();
          await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
          const info = await lstat(options.scratchRoot);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Application scratch directory unavailable");
          const scratch = await mkdtemp(join(options.scratchRoot, "run-"));
          const untrack = trackApplicationDirectory(scratch);
          try {
            callbacks.signal.throwIfAborted();
            return await createCodexApplicationEngine(
              {
                connection: options.connection,
                scratchDirectory: scratch,
                version: options.version,
                model: profile.model,
                timeoutMs: profile.activeTimeoutMs,
                purpose: options.purpose,
              },
              factory,
            ).run(input, callbacks);
          } finally {
            untrack();
            await rm(scratch, { recursive: true, force: true });
          }
        },
      };
    },
  };
}
