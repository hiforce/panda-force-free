export type NativeInput =
  | { type: "text"; text: string; path?: never; url?: never }
  | { type: "image"; url: string; path?: never; text?: never }
  | { type: "localImage"; path: string; url?: never; text?: never };

export interface ComposerAttachment {
  id: string;
  name: string;
  kind: string;
  status: string;
  url?: string;
  path?: string;
  error?: string;
}

export interface HistoryQuery {
  threadId?: string;
  revision?: string;
  oldestItemId?: string;
  cursor?: string | null;
  limit?: number;
  getCurrent?: () => boolean;
}

export interface NativeItemQuery {
  threadId: string;
  turnId?: string;
  cursor?: string | null;
  limit?: number;
  maxDurationMs?: number;
  now?: () => number;
}

export interface ProductProject {
  id: string;
  name: string;
  code: string;
  description?: string;
  workspace?: { path: string; state: "preparing" | "ready" };
}

export interface NativeTurn {
  id: string;
  status: string;
  items: readonly { id: string; type: string; content?: unknown; changes?: unknown }[];
}

export interface SessionActivity {
  status?: { type: string };
  turnId?: string;
  turnStatus?: string;
  completed?: boolean;
  historyTailId?: string;
  timestamp?: number;
}

export interface Suggestion {
  id: string;
  source?: string;
  title: string;
  description?: string;
  icon?: string;
  kind?: string;
  path?: string;
  threadId?: string;
  requiresThread?: boolean;
  descriptionKey?: import("./i18n/messages.js").MessageId | null;
  descriptionValues?: Record<string, string | number>;
}

export interface AutocompleteState {
  match: { type: string; query: string; start: number; end: number } | null;
  items: readonly Suggestion[];
  selected: number;
  requestId: number;
  message: string | { messageId: import("./i18n/messages.js").MessageId };
}

export interface ApprovalChoice {
  label: string;
  labelKey: string;
  labelValues?: Record<string, string | number>;
  decision: unknown;
}
export interface ApprovalModel {
  kind: string;
  identity: string;
  identityKey: string;
  identityValues?: Record<string, string | number>;
  title: string;
  titleKey?: string;
  titleValues?: Record<string, string | number>;
  subtitle?: string | null;
  subtitleKey?: string | null;
  subtitleValues?: Record<string, string | number>;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  primary: ApprovalChoice;
  deny: ApprovalChoice;
  leading: ApprovalChoice | null;
  scoped: ApprovalChoice | null;
  cancel: unknown;
  permissions?: Record<string, unknown>;
}
export interface DiffHunk {
  header: string;
  lines: Array<{ type: string; text: string }>;
}
export interface DiffFile {
  path: string;
  oldPath: string;
  linesAdded: number;
  linesDeleted: number;
  hunks: DiffHunk[];
}

export interface ConversationSnapshot {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  source?: string;
  sideTask?: boolean;
  turns?: readonly NativeTurn[];
  history?: { revision?: string; oldestItemId?: string | null };
}
