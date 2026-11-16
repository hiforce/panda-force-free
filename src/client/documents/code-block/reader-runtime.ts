import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, drawSelection } from "@codemirror/view";
import { foldGutter, bracketMatching } from "@codemirror/language";
import { codeHighlightAllowed } from "./limits.js";
import { documentCodeLanguage } from "./languages.js";
import { documentCodeTheme, documentCodeHighlighting } from "./theme.js";
export function createCodeReader(
  host: HTMLElement,
  text: string,
  language: string,
  wrap: boolean,
  phrases: Record<string, string>,
) {
  const wrapping = new Compartment(),
    view = new EditorView({
      parent: host,
      doc: text,
      extensions: [
        EditorState.phrases.of(phrases),
        lineNumbers(),
        foldGutter(),
        bracketMatching(),
        drawSelection(),
        documentCodeTheme,
        documentCodeHighlighting,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        codeHighlightAllowed(text) ? (documentCodeLanguage(language)?.syntax() ?? []) : [],
        wrapping.of(wrap ? EditorView.lineWrapping : []),
      ],
    });
  return {
    setWrap: (value: boolean) => view.dispatch({ effects: wrapping.reconfigure(value ? EditorView.lineWrapping : []) }),
    destroy: () => view.destroy(),
  };
}
