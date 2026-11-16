import type { SftpConnectionInput } from "./contracts.js";

export interface RemoteEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
}
/** Bounded, shell-free file operations shared by connection probes and site delivery. */
export interface RemoteFiles {
  stat(path: string): Promise<RemoteEntry | null>;
  realpath(path: string): Promise<string>;
  list(path: string): Promise<RemoteEntry[]>;
  read(path: string, maximum: number): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  atomicRename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  close(): void;
}
export interface RemoteFileFactory {
  connect(connection: SftpConnectionInput, credential: Record<string, unknown>): Promise<RemoteFiles>;
}
export interface RemoteSite {
  files: RemoteFiles;
  path: string;
  inspect(): Promise<void>;
  claim(): Promise<void>;
  assertOwned(): Promise<void>;
  probe(): Promise<void>;
  close(): void;
}
export interface RemoteSites {
  connect(connection: SftpConnectionInput, credential: Record<string, unknown>): Promise<RemoteSite>;
}
export class RemoteFileError extends Error {
  constructor(
    readonly code:
      | "connectionFailed"
      | "hostKeyMismatch"
      | "authenticationFailed"
      | "disconnected"
      | "notFound"
      | "permissionDenied"
      | "unsupported"
      | "invalidRemotePath"
      | "remoteLimit"
      | "operationFailed",
  ) {
    super(code);
  }
}
