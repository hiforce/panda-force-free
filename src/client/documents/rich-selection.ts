import { AllSelection, Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Native selectionchange can arrive after Enter; collapse whole-document selection in the same arrow transaction. */
export function collapseDocumentSelection(view: EditorView, event: KeyboardEvent): boolean {
  if (
    view.composing ||
    event.isComposing ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
    !(view.state.selection instanceof AllSelection)
  )
    return false;
  const rtl = getComputedStyle(view.dom).direction === "rtl",
    end = (event.key === "ArrowRight") !== rtl;
  view.dispatch(
    view.state.tr
      .setSelection(end ? Selection.atEnd(view.state.doc) : Selection.atStart(view.state.doc))
      .scrollIntoView(),
  );
  return true;
}
