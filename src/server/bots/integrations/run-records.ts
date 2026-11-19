import type { BotIntegrationConfig, BotIntegrationRunView, BotSourceItem } from "../../../shared/bots/integrations.js";
import type { BotWorkspaceRecord, BotWorkspaceWrite } from "../workspace/storage.js";
import type { SupportedLocale } from "../../../shared/i18n/contracts.js";

export interface BotIntegrationPart {
  itemIds: string[];
  taskId?: string;
  applied: boolean;
}
export interface BotIntegrationRunRecord {
  view: BotIntegrationRunView;
  config: BotIntegrationConfig;
  locale: SupportedLocale;
  generation: number;
  manual: boolean;
  lease?: string;
  items: BotSourceItem[];
  parts: BotIntegrationPart[];
  limited: boolean;
  failure?: string;
}
export interface BotIntegrationTaskLink {
  runId: string;
  integrationId: string;
  part: number;
}
export function integrationRunId(integrationId: string, requestId: string, now: number) {
  return integrationId + ":" + String(now).padStart(16, "0") + ":" + requestId;
}
export function integrationRunWrite(
  row: BotWorkspaceRecord,
  data: BotIntegrationRunRecord,
  dueAt: number | null,
): BotWorkspaceWrite {
  return {
    kind: "run",
    id: row.id,
    botId: row.botId,
    data,
    state: data.view.state,
    dueAt,
    expiresAt: data.view.createdAt + data.config.retentionDays * 86400000,
  };
}
export function integrationRunView(row: BotWorkspaceRecord<BotIntegrationRunRecord>) {
  return row.data.view;
}
