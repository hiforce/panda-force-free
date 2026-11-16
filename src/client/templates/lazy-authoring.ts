import { isModuleNetworkError } from "../documents/module-network-error.js";
import { DocumentRuntimeLoader } from "../documents/runtime-loader.js";
import { prepareDocumentModule } from "../documents/module-transfer.js";
import type { WritingSkillRuntime } from "./authoring-port.js";

const runtime = new DocumentRuntimeLoader<WritingSkillRuntime>({
  isTransferFailure: isModuleNetworkError,
  prime: (entry) => prepareDocumentModule(entry ? "/writing-skill.bundle.js?retry=1" : "/writing-skill.bundle.js"),
  evaluate: (entry) => (entry ? import("/writing-skill.bundle.js?retry=1") : import("/writing-skill.bundle.js")),
});
export const loadWritingSkillAuthoring = () => runtime.load();

/** Intent may download the editor, but never creates a draft or evaluates the rich editor. */
export async function prepareWritingSkillEditor() {
  const module = await runtime.load();
  module.prepareWritingEditor();
}
