import { connect } from "node:net";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";

export interface NativeProcessPlan {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export const launchReady = 0x01;
export const launchFrameLimit = 64 * 1024;
export const captureInputLimit = 16 * 1024 * 1024;
export const captureOutputLimit = 1024 * 1024;
export const cancelCapture = 0x03;

export interface NativeCapture {
  inputBytes: number;
  outputBytes: number;
}

// Provider credentials are provisioned in the worker, along with its fixed binaries and mounts.
const launchEnvironment = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "GROK_HOME",
  "GROK_DISABLE_AUTOUPDATER",
  "GROK_SHARED_DAEMON",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_PROJECT_DIR",
  "ZCODE_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_EXECUTABLE",
  "CLAUDE_AGENT_ACP_PROTOCOL",
  "DISABLE_AUTOUPDATER",
]);

export function nativeLaunchEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => launchEnvironment.has(key) && value !== undefined),
  );
}

export function nativeProcessSocket(env = process.env) {
  const socket = env.PANDA_FORCE_HARNESS_PROCESS_SOCKET;
  if (socket && (!/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.sock$/.test(socket) || Buffer.byteLength(socket) > 100))
    throw Error("The Harness process worker requires an absolute Unix socket path");
  return socket || undefined;
}

/** Do not start a Harness child in the process that can authenticate to the media worker. */
export function nativeProcessLaunchSocket(env = process.env) {
  const socket = nativeProcessSocket(env);
  if (!socket && (env.PANDA_FORCE_MEDIA_EXECUTOR_SOCKET || env.PANDA_FORCE_MEDIA_EXECUTOR_TOKEN_FILE))
    throw Error("A separate Harness process worker is required for local Harness launches when media is configured");
  return socket;
}

export async function nativeProcessScratch(env = process.env) {
  if (!nativeProcessLaunchSocket(env)) return tmpdir();
  const root = env.PANDA_FORCE_HARNESS_PROCESS_SCRATCH;
  if (!root || (await realpath(root)) !== root)
    throw Error("The Harness process worker requires a shared scratch directory");
  const info = await lstat(root);
  if (!info.isDirectory() || info.mode & 0o077)
    throw Error("The Harness scratch directory requires private permissions");
  return root;
}

export function nativeLaunchFrame({ command, args, cwd, env }: NativeProcessPlan, capture?: NativeCapture) {
  const frame = JSON.stringify({ command, args, cwd, env: nativeLaunchEnvironment(env), capture }) + "\n";
  if (Buffer.byteLength(frame) > launchFrameLimit) throw Error("Harness process launch exceeded the frame limit");
  return frame;
}
/** A successful spawn is acknowledged before the worker relays any stdout bytes. */
export function openNativeProcessSocket(
  path: string,
  plan: NativeProcessPlan,
  onReady: () => void,
  onData: (data: Buffer) => void,
  capture?: NativeCapture,
) {
  const frame = nativeLaunchFrame(plan, capture);
  const socket = connect(path);
  let ready = false;
  socket.once("connect", () => socket.write(frame));
  socket.setTimeout(6000, () => socket.destroy());
  socket.on("data", (data: Buffer) => {
    if (!ready) {
      if (data[0] !== launchReady) {
        socket.destroy();
        return;
      }
      ready = true;
      socket.setTimeout(0);
      onReady();
      data = data.subarray(1);
    }
    if (data.length) onData(data);
  });
  return socket;
}

/** Finite calls carry byte counts and wait for the worker's exit status. */
export async function captureNativeProcess(
  path: string,
  plan: NativeProcessPlan,
  input: Buffer,
  outputBytes: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (
    input.length > captureInputLimit ||
    !Number.isSafeInteger(outputBytes) ||
    outputBytes < 1 ||
    outputBytes > captureOutputLimit
  )
    throw Error("Invalid Harness capture bounds");
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let ready = false;
    let interrupted: ReturnType<typeof setTimeout> | undefined;
    const socket = openNativeProcessSocket(
      path,
      plan,
      () => {
        if (signal.aborted) {
          socket.destroy();
          return;
        }
        ready = true;
        if (input.length) socket.write(input);
      },
      (data) => {
        size += data.length;
        if (size <= outputBytes + 5) chunks.push(data);
        else socket.destroy();
      },
      { inputBytes: input.length, outputBytes },
    );
    function abort() {
      if (!ready) {
        socket.destroy();
        return;
      }
      if (!interrupted) {
        socket.write(Buffer.from([cancelCapture]));
        interrupted = setTimeout(() => socket.destroy(), 2500);
      }
    }
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () => socket.destroy());
    socket.once("close", (failed) => {
      signal.removeEventListener("abort", abort);
      if (interrupted) clearTimeout(interrupted);
      if (signal.aborted) return reject(signal.reason);
      if (!ready || failed || size < 5 || size > outputBytes + 5)
        return reject(Error("Harness capture did not complete"));
      const result = Buffer.concat(chunks, size);
      if (result[0] !== 0 || result.readUInt32BE(1) !== size - 5)
        return reject(Error("Harness capture did not complete"));
      resolve(result.subarray(5));
    });
    if (signal.aborted) abort();
  });
}
