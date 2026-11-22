export const REMOTE_CONNECTIONS_PATH = "/api/remote-connections";
export const REMOTE_HOST_KEY_PATH = REMOTE_CONNECTIONS_PATH + "/host-key";
export const REMOTE_TERMINAL_SOCKET = "/remote-terminal";
export const REMOTE_TOOL_PATH = "/tools/remote";

export interface RemoteHost {
  host: string;
  port: number;
}
export interface RemoteHostKey extends RemoteHost {
  hostKey: string;
}

export interface RemoteConnection extends RemoteHostKey {
  id: string;
  version: number;
  name: string;
  username: string;
  method: "password" | "privateKey";
}

export type RemoteCredential =
  { method: "password"; password: string } | { method: "privateKey"; privateKey: string; passphrase?: string };

export type RemoteConnectionInput = Omit<RemoteConnection, "method"> & {
  operationId: string;
  credential?: RemoteCredential;
};

export type RemoteErrorCode =
  | "denied"
  | "invalidInput"
  | "invalidHostKey"
  | "invalidCredential"
  | "missingCredential"
  | "notFound"
  | "conflict"
  | "unavailable"
  | "hostKeyMismatch"
  | "hostKeyUnavailable"
  | "authenticationFailed"
  | "connectionFailed"
  | "limit";

export type RemoteTerminalMessage = { type: "ready" } | { type: "error"; code: RemoteErrorCode };

export function remoteTerminalPath(id: string) {
  return `${REMOTE_TOOL_PATH}/terminal/${encodeURIComponent(id)}`;
}

export function remoteTerminalId(pathname: string) {
  return /^\/tools\/remote\/terminal\/([a-f0-9-]{36})\/?$/.exec(pathname)?.[1] ?? null;
}
