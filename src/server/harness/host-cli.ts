import { serveHostAgent } from "./host.js";

const [socketPath, separator, command, ...args] = process.argv.slice(2);
if (!socketPath || separator !== "--" || !command)
  throw Error("Usage: bun host-cli.ts /absolute/socket/path -- /absolute/executable [args]");
const uid = process.env.PANDA_FORCE_HOST_HARNESS_CLIENT_UID;
if (uid !== undefined && !/^\d+$/.test(uid)) throw Error("Use a numeric socket client UID");
const service = await serveHostAgent({
  socketPath,
  command,
  args,
  ...(uid === undefined ? {} : { clientUid: Number(uid) }),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void service.close().catch(() => {
      process.exitCode = 1;
    });
  });
console.log("Host Harness is listening on its Unix socket.");
