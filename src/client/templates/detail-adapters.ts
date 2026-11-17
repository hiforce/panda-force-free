import type { TemplateDetailPreviewRuntime } from "./ports.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { WritingSkillAuthoring } from "./authoring-port.js";
import type { TemplateCommands } from "./command-port.js";
import { CreationDrafts, selectCreationSkill } from "../creation/drafts.js";
import { PluginApiError } from "../plugins/api.js";
import { presentationManagerAdapters } from "./presentation-adapter.js";
import { skillManagerAdapter } from "./skill-adapter.js";
import { portableTemplateManagerAdapter } from "./portable-adapter.js";
import { nativeThemeManagerAdapter } from "./native-theme-adapter.js";
import { nativeSlidesManagerAdapter } from "./native-slides-adapter.js";

/** Reading a skill never initializes importers, authoring controllers or rich renderers. */
export function templateDetailAdapters(
  t: Translate,
  identity: string | undefined,
  commands: () => Promise<TemplateCommands | null>,
  authoring: () => Promise<WritingSkillAuthoring | null>,
  previews: () => Promise<TemplateDetailPreviewRuntime>,
  applySkill?: (selection: import("../../shared/creation/contracts.js").CreationSkillSelection) => void,
) {
  return [
    ...presentationManagerAdapters(t, async (draft) => {
      const value = await commands();
      return () => value?.editPresentation(draft);
    }),
    skillManagerAdapter(
      t,
      async (selection) => {
        if (applySkill) {
          applySkill(selection);
          return;
        }
        const drafts = new CreationDrafts(identity || "local", "personal"),
          saved = drafts.load();
        if (saved?.pending) throw new PluginApiError(409, { messageId: "creative.pendingCreation" });
        const value = saved || {
          prompt: "",
          profileId: "",
          parentId: null,
          selections: [],
          skillsVersion: 2 as const,
          pending: null,
        };
        value.selections = selectCreationSkill(value.selections, selection);
        value.skillsVersion = 2;
        drafts.save(value);
        history.pushState({}, "", "/create");
        dispatchEvent(new PopStateEvent("popstate"));
      },
      previews,
    ),
    portableTemplateManagerAdapter(
      t,
      async (reference) => {
        const runtime = await authoring();
        return runtime ? runtime.fork(reference) : () => {};
      },
      previews,
    ),
    nativeThemeManagerAdapter(t),
    nativeSlidesManagerAdapter(t),
  ];
}
