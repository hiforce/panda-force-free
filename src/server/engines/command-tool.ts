import { spawn } from "node:child_process";
import type { CommandTool } from "../../shared/engine/contracts.js";

/** Registered tools receive argv directly. They do not own a language-model conversation. */
export function createCommandTool({
  id,
  name,
  executable,
  timeoutMs = 60_000,
  maxOutputBytes = 4 * 1024 * 1024,
}: {
  id: string;
  name: string;
  executable: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): CommandTool {
  if (
    !executable ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0
  )
    throw new Error("Invalid command tool configuration");
  return {
    descriptor: Object.freeze({ id, name, kind: "command-tool" }),
    execute(arguments_, { signal } = {}) {
      signal?.throwIfAborted();
      if (!arguments_.every((argument) => typeof argument === "string" && !argument.includes("\0")))
        return Promise.reject(new Error("Invalid command tool arguments"));
      return new Promise((resolve, reject) => {
        const child = spawn(executable, [...arguments_], { stdio: ["ignore", "pipe", "pipe"], shell: false });
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        let bytes = 0,
          settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", abort);
        };
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
          killTimer.unref();
          reject(Object.assign(new Error(message), { code: "command_tool_interrupted", deliveryUncertain: true }));
        };
        const abort = () => fail("Command tool was cancelled");
        const timer = setTimeout(() => fail("Command tool timed out"), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        // Cancellation can race listener registration while the child starts.
        if (signal?.aborted) abort();
        const collect = (target: Buffer[], chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxOutputBytes) fail("Command tool output limit exceeded");
          else if (!settled) target.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
        child.once("close", (code) => {
          cleanup();
          if (settled) return;
          settled = true;
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: code ?? 1,
          });
        });
      });
    },
  };
}
