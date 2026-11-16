import { codexIcon, codexIconNodes } from "../codex-icons.js";
/** Unknown extension artwork cannot interrupt the application's navigation or startup. */
export function gadgetIcon(name: string) {
  return codexIcon(Object.hasOwn(codexIconNodes, name) ? name : "layout");
}
