import type { EngineEnvelope } from "../../shared/engine/contracts.js";
export type CodexConnection = { mode: "shared"; socketPath: string } | { mode: string; socketPath?: string };
export interface CodexTransportOptions {
  connection: CodexConnection;
  defaultCwd: string;
  clientInfo: { name: string; title: string; version: string };
  isShuttingDown(): boolean;
  onMessage(message: EngineEnvelope): void;
  onConnected(info: unknown): void;
  onDisconnected(code: number | null, signal: string | null): void;
}
export interface CodexTransport {
  readonly connected: boolean;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  sendRaw(message: object): void;
  start(): void;
  terminate(signal?: "SIGTERM" | "SIGKILL"): void;
  fullyStopped(): boolean;
  cancelRestart(): void;
  rejectPending(error: Error): void;
}
export type CodexTransportFactory = (options: CodexTransportOptions) => CodexTransport;
