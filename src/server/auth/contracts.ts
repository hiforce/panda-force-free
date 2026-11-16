import type { IncomingMessage, ServerResponse } from "node:http";
export interface PasswordAuth {
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  isAuthorized(request: IncomingMessage): Promise<boolean>;
  passwordSetupRequired(): boolean;
  installationCode(): string | null;
  watch(request: IncomingMessage, onRevoke: () => void): Promise<() => void>;
  close(): void;
}
