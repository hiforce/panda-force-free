import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, chown, lstat, realpath } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

interface HostAgentOptions {
  socketPath: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  clientUid?: number;
}

/** Give one trusted local PandaForce user a private connection to the account owner's native agent. */
export async function serveHostAgent(options: HostAgentOptions) {
  const { command, args, socketPath, clientUid } = options;
  if (
    process.platform !== "linux" ||
    !isAbsolute(command) ||
    !isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) > 100 ||
    (clientUid !== undefined && (!Number.isSafeInteger(clientUid) || clientUid < 0 || clientUid >= 2 ** 32 - 1))
  )
    throw Error("Use an absolute Linux executable and a short absolute Unix socket path");
  const directory = dirname(resolve(socketPath));
  const owner = await lstat(directory);
  if (
    !owner.isDirectory() ||
    owner.uid !== process.getuid?.() ||
    owner.mode & 0o022 ||
    (await realpath(directory)) !== directory
  )
    throw Error("Use a socket directory owned by the CLI user and writable only by that user");

  const active = new Map<Socket, ChildProcessWithoutNullStreams>();
  let ready = false;
  const stop = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    if (!ready || active.size >= 16) {
      socket.destroy();
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    active.set(socket, child);
    child.stderr.resume();
    child.stdin.on("error", () => socket.destroy());
    child.once("error", () => socket.destroy());
    child.once("close", () => {
      active.delete(socket);
      socket.end();
    });
    socket.once("close", () => {
      stop(child, "SIGTERM");
      if (active.has(socket)) {
        const timer = setTimeout(() => stop(child, "SIGKILL"), 1500);
        timer.unref();
        child.once("close", () => clearTimeout(timer));
      }
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });

  const close = async () => {
    ready = false;
    for (const socket of active.keys()) socket.destroy();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  };
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(socketPath, done);
  });
  try {
    await chmod(socketPath, 0o600);
    if (clientUid !== undefined) await chown(socketPath, clientUid, owner.gid);
  } catch (error) {
    await close();
    throw error;
  }
  ready = true;
  return { close };
}
