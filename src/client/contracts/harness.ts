import type { SessionControlView } from "./session-workspace.js";
/** Native transports and the composer share only this application-owned boundary. */
export interface HarnessBrowserBoundary {
  syncRoute(): void;
  rpc(method: string, params: Record<string, unknown>, next: () => Promise<unknown>): Promise<unknown>;
  available(): boolean;
  managed(): boolean;
  context(): string;
  controls(view: SessionControlView): SessionControlView;
  applyPermission(sessionId: string, mode: string): Promise<boolean>;
  applyRuntime(sessionId: string, runtimeId: string): Promise<string>;
}
