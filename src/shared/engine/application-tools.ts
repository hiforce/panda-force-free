import type { EngineQuestion } from "./questions.js";
import type { TokenUsage } from "./types.js";

export type ApplicationVisibleEvent =
  | { kind: "message"; id: string; text: string; complete: boolean; phase?: "commentary" | "final_answer" }
  | { kind: "usage"; usage: TokenUsage };

export interface ApplicationToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ApplicationRunScope {
  sessionId: string;
  runId: string;
}
export interface ApplicationToolCall extends ApplicationRunScope {
  callId: string;
  name: string;
  arguments: unknown;
}
export interface ApplicationToolResult {
  success: boolean;
  text: string;
  images?: readonly string[];
}
export type ApplicationQuestionAnswers = Record<string, { answers: string[] }>;
export interface ApplicationRunCallbacks {
  signal: AbortSignal;
  directory?: { readonly path: string; verify(): Promise<void> };
  session?(sessionId: string): void | Promise<void>;
  started(scope: ApplicationRunScope): void | Promise<void>;
  call(value: ApplicationToolCall): Promise<ApplicationToolResult>;
  question?(scope: ApplicationRunScope, questions: readonly EngineQuestion[]): Promise<ApplicationQuestionAnswers>;
  message?(text: string): void | Promise<void>;
  event?(event: ApplicationVisibleEvent): void | Promise<void>;
  control?(control: { steer(prompt: string): Promise<void> }): void | Promise<void>;
}
export interface ApplicationToolEngine {
  readonly id: string;
  /** Delete an application-owned engine conversation without touching shared engine credentials or state. */
  forget?(sessionId: string): Promise<void>;
  run(
    input: {
      sessionId?: string;
      persistent?: boolean;
      prompt: string;
      instructions: string;
      tools: readonly ApplicationToolDefinition[];
    },
    callbacks: ApplicationRunCallbacks,
  ): Promise<ApplicationRunScope & { status: "completed" | "failed" | "interrupted"; failure?: ApplicationRunFailure }>;
}

export type ApplicationRunFailure = "rateLimited" | "authentication" | "unavailable" | "failed";
