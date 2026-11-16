import type { SkillWorkspaceSnapshot } from "../../shared/skill-workspace.js";
export interface SkillWorkspaceRepository {
  read(owner: string): SkillWorkspaceSnapshot | Promise<SkillWorkspaceSnapshot>;
  replay(
    owner: string,
    id: string,
    request: string,
  ): SkillWorkspaceSnapshot | null | Promise<SkillWorkspaceSnapshot | null>;
  save(
    owner: string,
    id: string,
    request: string,
    expected: number,
    next: SkillWorkspaceSnapshot,
  ): SkillWorkspaceSnapshot | Promise<SkillWorkspaceSnapshot>;
  close(): void | Promise<void>;
}
