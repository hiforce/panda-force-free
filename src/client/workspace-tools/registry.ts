import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { codexIcon } from "../codex-icons.js";

export interface WorkspaceTool {
  id: string;
  label: MessageId;
  icon: Parameters<typeof codexIcon>[0];
  available(): boolean;
  create(t: Translate): { show(root: HTMLElement, url: URL): void; hide(): void };
}

/** Built-ins register through application composition. A personal link never registers an executable action. */
export function createWorkspaceToolRegistry(definitions: readonly WorkspaceTool[]) {
  const tools = new Map<string, Readonly<WorkspaceTool>>();
  for (const tool of definitions) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(tool.id) || tools.has(tool.id)) throw Error("Invalid workspace tool ID");
    tools.set(tool.id, Object.freeze({ ...tool }));
  }
  return {
    all: () => Array.from(tools.values()).filter((tool) => tool.available()),
    get: (id: string) => tools.get(id),
  };
}
