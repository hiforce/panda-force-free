import type { CreationTaskDetail } from "../../shared/creation/contracts.js";
import type { EngineItem } from "../../shared/engine/types.js";
import type { SessionControlView } from "../contracts/session-workspace.js";

export interface CreationWorkspaceBridge {
  controls(): SessionControlView;
  cwd(): string;
  openGoal(draft?: import("../../shared/engine/types.js").Goal): void;
  clear(): void;
  restoreDraft(): void;
  saveDraft(scope?: string): void;
  accepted(scope: string, nextScope: string, prompt: string, materialIds: readonly string[]): void;
  seedDraft(text: string, selections: NonNullable<CreationTaskDetail["selections"]>, allowEmpty?: boolean): void;
  render(item: EngineItem, turnId: string): void;
  preserve(render: () => void): void;
  reset(discovery?: boolean): void;
  changed(): void;
  selections(): readonly import("../../shared/creation/contracts.js").CreationSkillSelection[];
  selectSkill(selection: import("../../shared/creation/contracts.js").CreationSkillSelection): void;
}
