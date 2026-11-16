import { Client } from "ssh2";
import { createHash } from "node:crypto";
import type { SftpConnectionInput } from "../../shared/connections/contracts.js";
import type { RemoteFileFactory, RemoteFiles } from "../../shared/connections/remote-files.js";
import { RemoteFileError } from "../../shared/connections/remote-files.js";
import { SftpFiles } from "./session.js";

/** No agent, implicit SSH files, commands or port forwarding are exposed to publication code. */
export class SftpFileFactory implements RemoteFileFactory {
  constructor(private limits = { operationMs: 15000, sessionMs: 300000 }) {}
  connect(connection: SftpConnectionInput, credential: Record<string, unknown>): Promise<RemoteFiles> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false,
        mismatch = false;
      const fail = (code: RemoteFileError["code"]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        reject(new RemoteFileError(code));
      };
      const timer = setTimeout(() => fail("connectionFailed"), 12000);
      client.on("error", (error) =>
        fail(
          mismatch
            ? "hostKeyMismatch"
            : error.level === "client-authentication"
              ? "authenticationFailed"
              : "connectionFailed",
        ),
      );
      client.on("close", () => fail("connectionFailed"));
      client.on("ready", () =>
        client.sftp((error, sftp) => {
          if (error) return fail("connectionFailed");
          if (settled) {
            client.destroy();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(new SftpFiles(client, sftp, this.limits.operationMs, this.limits.sessionMs));
        }),
      );
      try {
        client.connect({
          host: connection.host,
          port: connection.port,
          username: connection.username,
          readyTimeout: 10000,
          keepaliveInterval: 5000,
          keepaliveCountMax: 2,
          tryKeyboard: false,
          ...(credential.method === "password"
            ? { password: String(credential.password) }
            : {
                privateKey: String(credential.privateKey),
                ...(credential.passphrase ? { passphrase: String(credential.passphrase) } : {}),
              }),
          hostVerifier: (key: Buffer) => {
            mismatch =
              "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "") !== connection.hostKey;
            return !mismatch;
          },
        });
      } catch {
        fail("authenticationFailed");
      }
    });
  }
}
