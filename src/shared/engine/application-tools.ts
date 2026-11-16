import type { EngineQuestion } from "./questions.js";

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
  session?(sessionId: string): void | Promise<void>;
  started(scope: ApplicationRunScope): void | Promise<void>;
  call(value: ApplicationToolCall): Promise<ApplicationToolResult>;
  question?(scope: ApplicationRunScope, questions: readonly EngineQuestion[]): Promise<ApplicationQuestionAnswers>;
}
export interface ApplicationToolEngine {
  readonly id: string;
  run(
    input: {
      sessionId?: string;
      persistent?: boolean;
      prompt: string;
      instructions: string;
      tools: readonly ApplicationToolDefinition[];
    },
    callbacks: ApplicationRunCallbacks,
  ): Promise<ApplicationRunScope & { status: "completed" | "failed" | "interrupted" }>;
}
