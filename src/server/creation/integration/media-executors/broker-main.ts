import { lstat, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { connect } from "node:net";
import { CreationMediaExecutors } from "./service.js";
import { readMediaBrokerToken, serveMediaBroker } from "./broker.js";

const socket = process.env.PANDA_FORCE_MEDIA_EXECUTOR_SOCKET,
  tokenPath = process.env.PANDA_FORCE_MEDIA_EXECUTOR_TOKEN_FILE,
  state = process.env.PANDA_FORCE_MEDIA_EXECUTOR_PRIVATE_STATE;
if (!socket || !tokenPath || !state || ![socket, tokenPath, state].every(isAbsolute) || Buffer.byteLength(socket) > 100)
  throw new Error("The media worker requires explicit private socket, token and state paths");
process.umask(0o077);
const privateState = await lstat(state),
  directory = dirname(socket),
  socketDirectory = await lstat(directory);
if (
  !privateState.isDirectory() ||
  privateState.mode & 0o077 ||
  !socketDirectory.isDirectory() ||
  socketDirectory.mode & 0o027 ||
  (await realpath(state)) !== state ||
  (await realpath(directory)) !== directory ||
  (process.getuid && (privateState.uid !== process.getuid() || socketDirectory.uid !== process.getuid()))
)
  throw new Error("The media worker paths require separate private-state and socket permissions");
try {
  const prior = await lstat(socket);
  if (!prior.isSocket() || (process.getuid && prior.uid !== process.getuid()))
    throw new Error("Unsafe existing media worker socket");
  const listening = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(socket);
    probe.setTimeout(1000, () => {
      probe.destroy();
      reject(new Error("Media worker socket did not respond"));
    });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNREFUSED" ? resolve(false) : reject(new Error("Media worker socket unavailable")),
    );
  });
  if (listening) throw new Error("A media worker is already listening");
  await unlink(socket);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const token = await readMediaBrokerToken(tokenPath);
const broker = await serveMediaBroker(socket, token, new CreationMediaExecutors(state));
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
console.log("Creation media worker is listening on its private Unix socket.");
