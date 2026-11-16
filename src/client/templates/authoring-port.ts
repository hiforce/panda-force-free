import type { createTemplateAuthoring } from "./authoring/controller.js";
export type WritingSkillAuthoring = ReturnType<typeof createTemplateAuthoring>;
export interface WritingSkillRuntime {
  createTemplateAuthoring: typeof createTemplateAuthoring;
  prepareWritingEditor(): void;
}
