/** Public connection records never contain credentials or an untrusted owner identity. */
interface ConnectionIdentity {
  id: string;
  projectId: string;
  name: string;
  publicUrl: string;
}
export interface LocalConnectionInput extends ConnectionIdentity {
  connector: "local-site";
  root: string;
  directory: string;
}
export interface SftpConnectionInput extends ConnectionIdentity {
  connector: "sftp-site";
  host: string;
  port: number;
  username: string;
  hostKey: string;
  directory: string;
}
export type ConnectionInput = LocalConnectionInput | SftpConnectionInput;
export type PublicationConnection = ConnectionInput & {
  version: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  credentialRevision?: number;
  trustPending?: boolean;
};
export type SftpConnection = PublicationConnection & SftpConnectionInput;
export interface ConnectionTest {
  capabilities: readonly "site.publish"[];
  servedPath: string;
  atomicSwitch: boolean;
}
export interface PublicationRoot {
  id: string;
  path: string;
}
