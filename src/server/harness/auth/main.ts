import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { connect } from "node:net";
import { GrokAccountCredentials, renewGrokAccount } from "./grok-account.js";
import { serveCredentialBroker } from "./broker.js";

const accountHome = process.env.PANDA_FORCE_GROK_AUTH_HOME;
const socketPath = process.env.PANDA_FORCE_GROK_AUTH_SOCKET;
const command = process.env.PANDA_FORCE_GROK_AUTH_COMMAND;
if (
  !accountHome ||
  !socketPath ||
  !command ||
  ![accountHome, socketPath, command].every(isAbsolute) ||
  Buffer.byteLength(socketPath) > 100
)
  throw Error("Explicit absolute Grok account, command and private socket paths are required");
process.umask(0o077);
const directory = dirname(socketPath);
await mkdir(directory, { recursive: true, mode: 0o700 });
const parent = await lstat(directory);
if (
  !parent.isDirectory() ||
  parent.isSymbolicLink() ||
  parent.mode & 0o077 ||
  (process.getuid && parent.uid !== process.getuid())
)
  throw Error("Credential socket requires an owner-only directory");
try {
  const previous = await lstat(socketPath);
  if (!previous.isSocket() || (process.getuid && previous.uid !== process.getuid()))
    throw Error("Unsafe existing credential socket");
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(Error("Credential socket did not respond"));
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNREFUSED" ? resolve(false) : reject(Error("Credential socket inspection failed")),
    );
  });
  if (active) throw Error("Credential owner is already running");
  await unlink(socketPath);
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}
await chmod(directory, 0o700);
const source = new GrokAccountCredentials({
  accountHome,
  renew: () => renewGrokAccount({ accountHome, command }),
});
const broker = await serveCredentialBroker(socketPath, source);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void broker.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
console.log("Grok credential owner is ready on its private Unix socket.");
