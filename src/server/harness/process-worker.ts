import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { errorCode } from "../../shared/errors.js";
import { isRecord } from "../../shared/records.js";
import { inside } from "../path-utils.js";
import {
  cancelCapture,
  captureInputLimit,
  captureOutputLimit,
  launchFrameLimit,
  launchReady,
  nativeLaunchEnvironment,
  nativeProcessSocket,
  type NativeCapture,
} from "../engines/native-process.js";

function strings(raw: string | undefined, limit: number): string[] {
  const value: unknown = JSON.parse(raw ?? "[]");
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > limit ||
    value.some((item) => typeof item !== "string" || !item || item.includes("\0"))
  )
    throw Error("Invalid Harness process worker configuration");
  return value;
}

const socketPath = nativeProcessSocket();
const uid = process.getuid?.();
if (!socketPath || !uid) throw Error("The Harness process worker requires a socket and a non-root account");
const commands = new Map<string, string>();
for (const spec of strings(process.env.PANDA_FORCE_HARNESS_PROCESS_COMMANDS, 64)) {
  const separator = spec.indexOf("=");
  const name = separator < 0 ? spec : spec.slice(0, separator);
  const path = separator < 0 ? spec : spec.slice(separator + 1);
  if ((!isAbsolute(name) && !/^[A-Za-z0-9._-]+$/.test(name)) || !isAbsolute(path) || commands.has(name))
    throw Error("Invalid Harness process worker executable");
  const executable = await realpath(path);
  const file = await lstat(executable);
  if (!file.isFile() || file.mode & 0o022 || !(file.mode & 0o111))
    throw Error("The Harness process worker requires private executable files");
  commands.set(name, executable);
}
const roots = await Promise.all(
  strings(process.env.PANDA_FORCE_HARNESS_PROCESS_ROOTS, 16).map(async (root) => {
    if (!isAbsolute(root) || root === "/" || (await realpath(root)) !== root || !(await lstat(root)).isDirectory())
      throw Error("The Harness process worker requires canonical workspace roots");
    return root;
  }),
);
const directory = dirname(socketPath);
const info = await lstat(directory);
if (!info.isDirectory() || info.uid !== uid || info.mode & 0o027 || (await realpath(directory)) !== directory)
  throw Error("The Harness process worker socket directory requires private permissions");

const umask = process.umask(0o077);
try {
  const previous = await lstat(socketPath);
  if (!previous.isSocket() || previous.uid !== uid) throw Error("Unsafe existing Harness process socket");
  await new Promise<void>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      reject(Error("A Harness process worker is already listening"));
    });
    probe.setTimeout(1000, () => {
      probe.destroy();
      reject(Error("Harness process socket did not respond"));
    });
    probe.on("error", (error) => {
      if (errorCode(error) === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  await unlink(socketPath);
} catch (error) {
  if (errorCode(error) !== "ENOENT") throw error;
}

const stop = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
};
const sockets = new Set<Socket>();
let captures = 0;
const server = createServer((socket) => {
  socket.on("error", () => socket.destroy());
  if (sockets.size >= 32) return socket.destroy();
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.setTimeout(5000, () => socket.destroy());
  let frame = Buffer.alloc(0);
  function accept(data: Buffer) {
    try {
      if (frame.length + data.length > launchFrameLimit) return socket.destroy();
      frame = Buffer.concat([frame, data]);
      const end = frame.indexOf(10);
      if (end < 0) return;
      socket.off("data", accept);
      socket.pause();
      if (end + 1 !== frame.length) return socket.destroy();
      void launch(socket, JSON.parse(frame.toString("utf8", 0, end))).catch(() => socket.destroy());
    } catch {
      socket.destroy();
    }
  }
  socket.on("data", accept);
});

async function launch(socket: Socket, value: unknown) {
  if (!isRecord(value) || typeof value.command !== "string" || typeof value.cwd !== "string" || !isAbsolute(value.cwd))
    throw Error("Invalid Harness launch");
  const command = commands.get(value.command);
  const { args, env } = value;
  if (
    !command ||
    !Array.isArray(args) ||
    args.length > 128 ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !isRecord(env) ||
    Object.values(env).some((value) => typeof value !== "string" || value.includes("\0"))
  )
    throw Error("Invalid Harness launch");
  const cwd = await realpath(value.cwd);
  if (cwd !== value.cwd || !roots.some((root) => inside(cwd, root)) || !(await lstat(cwd)).isDirectory())
    throw Error("Harness workspace is outside the worker mounts");
  if (socket.destroyed) return;
  const capture = parseCapture(value.capture);
  if (capture && captures >= 4) throw Error("Harness capture capacity exhausted");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...nativeLaunchEnvironment(env as NodeJS.ProcessEnv) },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: true,
  });
  if (capture) {
    captures++;
    child.once("close", () => captures--);
  }
  child.stderr.resume();
  child.stdin.on("error", () => socket.destroy());
  child.on("error", () => socket.destroy());
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    if (closed || timer) return;
    stop(child, "SIGTERM");
    timer = setTimeout(() => stop(child, "SIGKILL"), 1500);
    timer.unref();
  };
  socket.once("close", interrupt);
  child.once("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (!capture) socket.end();
  });
  if (capture) captureChild(socket, child, capture, interrupt);
  child.once("spawn", () => {
    if (socket.destroyed) return;
    socket.setTimeout(0);
    socket.write(Buffer.from([launchReady]));
    if (!capture) {
      socket.pipe(child.stdin);
      child.stdout.pipe(socket, { end: false });
    }
    socket.resume();
  });
}

function parseCapture(value: unknown): NativeCapture | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) throw Error("Invalid Harness capture");
  const { inputBytes, outputBytes } = value;
  if (
    typeof inputBytes !== "number" ||
    !Number.isSafeInteger(inputBytes) ||
    inputBytes < 0 ||
    inputBytes > captureInputLimit ||
    typeof outputBytes !== "number" ||
    !Number.isSafeInteger(outputBytes) ||
    outputBytes < 1 ||
    outputBytes > captureOutputLimit
  )
    throw Error("Invalid Harness capture");
  return { inputBytes, outputBytes };
}

function captureChild(
  socket: Socket,
  child: ChildProcessWithoutNullStreams,
  { inputBytes, outputBytes }: NativeCapture,
  interrupt: () => void,
) {
  const input = Buffer.alloc(inputBytes);
  const chunks: Buffer[] = [];
  let received = 0,
    size = 0,
    invalid = false;
  socket.on("data", (data: Buffer) => {
    const count = Math.min(data.length, inputBytes - received);
    if (count < data.length) {
      if (data.length === count + 1 && data[count] === cancelCapture) interrupt();
      else socket.destroy();
      return;
    }
    data.copy(input, received);
    received += count;
    if (received === inputBytes) child.stdin.end(input);
  });
  if (inputBytes === 0) child.once("spawn", () => child.stdin.end());
  child.stdout.on("data", (data: Buffer) => {
    if (invalid) return;
    if (size + data.length > outputBytes) {
      invalid = true;
      interrupt();
    } else {
      size += data.length;
      chunks.push(data);
    }
  });
  child.once("close", (code) => {
    const result = Buffer.alloc(5);
    if (invalid || code !== 0 || received !== inputBytes) {
      result[0] = 1;
      socket.end(result);
    } else {
      result.writeUInt32BE(size, 1);
      socket.end(Buffer.concat([result, ...chunks], 5 + size));
    }
  });
}

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, () => {
    server.off("error", reject);
    resolve();
  });
});
await chmod(socketPath, 0o660);
process.umask(umask);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
