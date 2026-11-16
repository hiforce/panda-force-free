import type { ManagedTemplate } from "../../shared/templates/catalog.js";
export interface SkillWorkspaceActions {
  ready(): boolean;
  isPinned(key: string): boolean;
  togglePin(item: ManagedTemplate): Promise<void>;
  assign(item: ManagedTemplate): void;
}
