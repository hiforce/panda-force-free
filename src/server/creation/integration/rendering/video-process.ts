import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { CreationError } from "../../contracts.js";

/** Only administrator-selected binaries and application-built arguments run here; child credentials are not inherited. */
export async function creationVideoProcess(
  binary: string,
  args: readonly string[],
  options: {
    cwd?: string;
    signal: AbortSignal;
    timeoutMs: number;
    authorize?(): Promise<void>;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  await options.authorize?.();
  options.signal.throwIfAborted();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    env = Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "XDG_CACHE_HOME", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "LD_LIBRARY_PATH"].flatMap(
        (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
      ),
    );
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [...args], { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    if (child.pid) {
      try {
        setPriority(child.pid, 10);
      } catch {}
    }
    const output: Buffer[] = [];
    let size = 0,
      stderr = "",
      failure: unknown,
      finished = false,
      checking = false,
      kill: ReturnType<typeof setTimeout> | undefined;
    const unavailable = (cause?: unknown) => {
      const error = new CreationError("unavailable");
      error.cause = cause ?? new Error(stderr);
      return error;
    };
    const stop = (error: unknown) => {
      failure ??= error;
      if (child.exitCode === null && child.signalCode === null && !child.killed) {
        child.kill("SIGTERM");
        kill = setTimeout(() => child.kill("SIGKILL"), 2000);
        kill.unref();
      }
    };
    const abort = () => stop(signal.reason);
    const permission = setInterval(() => {
      if (!options.authorize || checking || finished) return;
      checking = true;
      void options
        .authorize()
        .catch(stop)
        .finally(() => {
          checking = false;
        });
    }, 3000);
    permission.unref();
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearInterval(permission);
      if (kill) clearTimeout(kill);
      signal.removeEventListener("abort", abort);
      if (failure || error || signal.aborted) reject(failure ?? error ?? signal.reason);
      else resolve(Buffer.concat(output).toString("utf8"));
    };
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 256 * 1024) stop(new CreationError("unavailable"));
      else output.push(bytes);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString("utf8")).slice(-8192);
    });
    child.once("error", (error) => finish(unavailable(error)));
    child.once("close", (code) => finish(code === 0 ? undefined : unavailable()));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
