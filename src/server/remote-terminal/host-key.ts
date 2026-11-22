import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Client } from "ssh2";
import { connectionText } from "../connections/validation.js";
import type { RemoteHost, RemoteHostKey } from "../../shared/workspace-tools/remote.js";
import { RemoteError } from "./errors.js";

export function remoteHost(input: Record<string, unknown>): RemoteHost {
  let host: string;
  try {
    host = connectionText(input.host, 253).toLowerCase();
  } catch {
    throw new RemoteError("invalidInput");
  }
  const port = input.port;
  if (
    (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) ||
    host.includes("..") ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new RemoteError("invalidInput");
  return { host, port };
}

export const sshHostFingerprint = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

/** Read the key offered during key exchange. Always reject it before user authentication. */
export class RemoteHostKeyProbe {
  private readonly active = new Map<string, { owner: string; result: Promise<RemoteHostKey>; stop(): void }>();

  read(owner: string, input: Record<string, unknown>) {
    if (Object.keys(input).some((name) => name !== "host" && name !== "port")) throw new RemoteError("invalidInput");
    const target = remoteHost(input);
    const id = JSON.stringify([owner, target.host, target.port]);
    const previous = this.active.get(id);
    if (previous) return previous.result;
    if (this.active.size >= 16 || [...this.active.values()].filter((entry) => entry.owner === owner).length >= 3)
      throw new RemoteError("limit");
    const client = new Client();
    const deferred = Promise.withResolvers<RemoteHostKey>();
    let complete = false;
    const finish = (hostKey?: string) => {
      if (complete) return;
      complete = true;
      this.active.delete(id);
      clearTimeout(timer);
      client.destroy();
      if (hostKey) deferred.resolve({ ...target, hostKey });
      else deferred.reject(new RemoteError("hostKeyUnavailable"));
    };
    const timer = setTimeout(() => finish(), 8000);
    this.active.set(id, { owner, result: deferred.promise, stop: () => finish() });
    let observed: string | undefined;
    client.on("error", () => finish(observed));
    client.once("close", () => finish(observed));
    try {
      client.connect({
        ...target,
        username: "host-key-probe",
        readyTimeout: 7000,
        authHandler: () => false,
        hostVerifier: (key: Buffer) => {
          observed = sshHostFingerprint(key);
          return false;
        },
      });
    } catch {
      finish();
    }
    return deferred.promise;
  }
  close() {
    for (const probe of this.active.values()) probe.stop();
  }
}
