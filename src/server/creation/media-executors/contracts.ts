import type {
  CreationMediaBinding,
  CreationMediaChoice,
  CreationMediaCliInstructions,
  CreationMediaCliRegistration,
  CreationMediaExecutor,
  CreationMediaCredential,
  CreationMediaKind,
  CreationMediaPreset,
} from "../../../shared/creation/media-executors.js";

export const mediaExecutorErrors = [
  "invalidInput",
  "notFound",
  "conflict",
  "authentication",
  "rateLimited",
  "unavailable",
  "uncertain",
  "failed",
  "cancelled",
  "stoppedLocally",
  "invalidResult",
] as const;
export class MediaExecutorError extends Error {
  constructor(readonly code: (typeof mediaExecutorErrors)[number]) {
    super(code);
    this.name = "MediaExecutorError";
  }
}

export interface MediaRequest {
  id: string;
  kind: CreationMediaKind;
  prompt: string;
  model: string;
}

export type MediaResult =
  { state: "succeeded"; bytes: Buffer; invocationId?: string } | { state: "pending"; taskId: string };

export type MediaPoll = MediaResult | { state: "failed" };
export type MediaStop = { state: "cancelled" | "stoppedLocally" };

export interface MediaConnection {
  baseUrl: string;
  apiKey: string;
}

export interface MediaProvider {
  check(connection: MediaConnection, signal: AbortSignal, model?: string): Promise<"connected" | "unverified">;
  submit(connection: MediaConnection, request: MediaRequest, signal: AbortSignal): Promise<MediaResult>;
  poll?(connection: MediaConnection, taskId: string, signal: AbortSignal): Promise<MediaPoll>;
  cancel?(connection: MediaConnection, taskId: string, signal: AbortSignal): Promise<MediaStop>;
}

export type ExternalMediaChoice = Extract<CreationMediaChoice, { source: "executor" }>;
export type ExternalMediaBinding = Extract<CreationMediaBinding, { source: "executor" }>;

export interface CreationMediaExecutorPort {
  cliCatalog(): Promise<CreationMediaCliRegistration[]>;
  cliInstructions(id: string, revision: number): Promise<CreationMediaCliInstructions>;
  registerCli(id: string, revision: number, fingerprint: string, signal: AbortSignal): Promise<void>;
  list(
    owner: string,
  ): Promise<{
    presets: CreationMediaPreset[];
    executors: CreationMediaExecutor[];
    credentials: CreationMediaCredential[];
  }>;
  saveCredential(owner: string, input: unknown): Promise<CreationMediaCredential>;
  removeCredential(owner: string, id: string, revision: number): Promise<void>;
  save(owner: string, input: unknown): Promise<CreationMediaExecutor>;
  remove(owner: string, id: string, revision: number): Promise<void>;
  bind(owner: string, selection: ExternalMediaChoice): Promise<ExternalMediaBinding>;
  assertBound(owner: string, binding: ExternalMediaBinding): Promise<void>;
  submit(
    owner: string,
    binding: ExternalMediaBinding,
    id: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<MediaResult>;
  poll(owner: string, binding: ExternalMediaBinding, taskId: string, signal: AbortSignal): Promise<MediaPoll>;
  cancel(owner: string, binding: ExternalMediaBinding, taskId: string, signal: AbortSignal): Promise<MediaStop>;
}
