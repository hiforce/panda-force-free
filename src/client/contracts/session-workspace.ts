import type { MessageId } from "../../shared/i18n/messages.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { I18nRuntime } from "./platform.js";

export interface SessionUsageView {
  total: number | null;
  input: number | null;
  output: number | null;
  cached: number | null;
  context: number | null;
  window: number | null;
  contextPercent: number | null;
  inputPercent: number | null;
}

export interface SessionWorkspaceView {
  id: string;
  title: string;
  cwd: string;
  project: { id: string; name: string; code: string } | null;
  status: { state: string; label: string; detail: string; icon: string } | null;
  usage: SessionUsageView;
  elapsedMs: number | null;
  hasGoal: boolean;
  modelLabel: string;
  effortLabel: string;
  permissionLabel: string;
}

export interface SessionTool {
  id: string;
  title: MessageId;
  description: MessageId;
  icon: string;
  enabled: boolean;
  activate: () => void;
}

export interface SessionToolRegistry {
  all(): readonly SessionTool[];
  get(id: string): SessionTool | undefined;
}

export interface ToolPreferences {
  pinned: string[];
  disabled: string[];
}

export interface SessionToolDocument {
  note: string;
  checks: Array<{ id: string; text: string; done: boolean }>;
}

export interface SessionToolStorage {
  preferences(): ToolPreferences;
  pin(id: string): boolean;
  move(id: string, direction: number): void;
  enable(id: string, enabled: boolean): void;
  document(id: string): SessionToolDocument;
  saveDocument(id: string, value: SessionToolDocument): boolean;
}

export interface SessionWorkspaceOptions {
  t: Translate;
  i18n: I18nRuntime;
  read: () => SessionWorkspaceView;
  isSessionPage: () => boolean;
  registry: SessionToolRegistry;
  store: SessionToolStorage;
  associateProject: () => void;
  openSettings: (kind: "model" | "permissions") => void;
  openSessionActions: () => void;
  beforeOpen: () => void;
  toast: (message: string) => void;
  pendingAction: () => void;
  search: () => void;
  layoutChanged: () => void;
}

export interface SessionControlView {
  sessionId: string;
  model: string;
  effort: string;
  permission: string;
  models: Array<{ id: string; label: string; defaultEffort: string; efforts: Array<{ id: string; label: string }> }>;
  permissions: Array<{ id: string; label: string; description: string; allowed: boolean }>;
}

export interface SessionSettingsDialogOptions {
  t: Translate;
  read: () => SessionControlView;
  applyModel: (sessionId: string, model: string, effort: string) => void;
  applyPermission: (sessionId: string, mode: string) => void;
  reloadModels: () => Promise<boolean>;
  onError: (message: string) => void;
}
