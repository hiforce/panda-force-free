import CodeBlock from "@tiptap/extension-code-block";
import type { Translate } from "../../../shared/i18n/messages.js";
import { CodeLanguagePicker } from "./language-picker.js";
import { DocumentCodeBlockView } from "./node-view.js";
/** The extension owns one picker and a set of live block views; the shared server schema stays presentation-free. */
export function createDocumentCodeBlocks(t: Translate, error: (value: unknown) => void) {
  let picker: CodeLanguagePicker | null = null;
  const views = new Set<DocumentCodeBlockView>();
  return {
    extension: CodeBlock.extend({
      addNodeView() {
        return (props) => {
          picker ??= new CodeLanguagePicker(props.view.dom, t);
          const view = new DocumentCodeBlockView(props.node, props.editor, props.getPos, picker, t, error);
          views.add(view);
          const destroy = view.destroy.bind(view);
          view.destroy = () => {
            views.delete(view);
            destroy();
          };
          return view;
        };
      },
    }).configure({ enableTabIndentation: true, tabSize: 2 }),
    setEditable() {
      for (const view of views) view.setEditable();
    },
    close() {
      picker?.close();
      picker = null;
    },
  };
}
