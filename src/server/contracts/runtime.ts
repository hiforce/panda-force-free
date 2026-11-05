import type { IncomingMessage, ServerResponse } from "node:http";
import type { NativeInput } from "../../shared/data-contracts.js";
import type { ProjectSnapshot, ProjectVisibility, SessionSummary } from "../../shared/engine/types.js";
import type { AttachmentStorage } from "../workspace/attachment-types.js";
import type { AccountIdentity } from "../misc/profile.js";
export interface IdentitySession {
  id: string;
  identity: unknown;
  expiresAt: number;
}
export interface IdentityAuth {
  authenticate(request: IncomingMessage): Promise<IdentitySession>;
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  watch(id: string, close: () => void): () => void;
  close(): void;
}
export interface ObjectAttachmentStorage extends AttachmentStorage {
  readonly urlPrefix: string;
  readUrl(url: unknown): Promise<string>;
  present<T>(value: T): T;
  prepareInput(input: readonly NativeInput[]): Promise<NativeInput[]>;
}
export type ImageThumbnail = (image: {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}) => Promise<Buffer>;
export interface EngineConnection {
  mode: string;
  socketPath?: string;
}
export interface AccountLoader {
  get(refresh?: boolean): Promise<AccountIdentity>;
  invalidate(): void;
}
export interface ProjectVisibilityRepository {
  snapshot(): ProjectVisibility;
  setHidden(project: unknown, hidden: boolean, expectedHiddenAt?: unknown): boolean;
}
export interface ProjectRepository {
  snapshot(): ProjectSnapshot;
  project(id: string): unknown;
  save(input: unknown, revision: unknown): ProjectSnapshot;
  assign(
    projectId: string | null,
    sessions: readonly { id: string; name?: string; cwd?: string }[],
    revision: unknown,
  ): ProjectSnapshot;
  refreshSessions(sessions: readonly SessionSummary[]): ProjectSnapshot | null;
  forgetSession(id: string): ProjectSnapshot | null;
}
