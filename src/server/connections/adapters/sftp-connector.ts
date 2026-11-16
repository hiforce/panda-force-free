import type { ConnectionConnector, ConnectionSecrets } from "../connector-port.js";
import type { RemoteSites } from "../../../shared/connections/remote-files.js";
import { ConnectionError } from "../errors.js";
import { sftpInput, sftpCredential } from "./sftp-input.js";

export function sftpConnector(sites: RemoteSites, secrets: ConnectionSecrets): ConnectionConnector {
  return {
    id: "sftp-site",
    parse: sftpInput,
    roots: () => [],
    credential: sftpCredential,
    ready: (connection) => {
      if (!connection.credentialRevision) throw new ConnectionError("credentialMissing", 409);
      if (connection.trustPending) throw new ConnectionError("trustUnverified", 409);
    },
    target: (input) => {
      if (input.connector !== "sftp-site") throw new ConnectionError("invalidInput");
      return `sftp://${input.username}@${input.host.includes(":") ? "[" + input.host + "]" : input.host}:${input.port}${input.directory.split("/").map(encodeURIComponent).join("/")}`;
    },
    // Saving public configuration performs no remote action; testing requires separately stored credentials.
    inspect: async () => {},
    test: async (owner, connection) => {
      if (connection.connector !== "sftp-site") throw new ConnectionError("invalidInput");
      const site = await sites.connect(connection, await secrets.read(owner, connection));
      try {
        await site.probe();
        return { capabilities: ["site.publish"], servedPath: connection.directory + "/current", atomicSwitch: true };
      } finally {
        site.close();
      }
    },
  };
}
