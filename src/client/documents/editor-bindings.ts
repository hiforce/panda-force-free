interface EditorHostActions {
  capture(): void;
  save(): Promise<unknown>;
  focus(): void;
  action(name: string): Promise<unknown>;
  error(error: unknown): void;
}

/** Shared DOM interactions own no draft, network, toolbar runtime or persistence state. */
export function bindDocumentEditorHost(host: HTMLElement, signal: AbortSignal, actions: EditorHostActions): void {
  const ElementClass = host.ownerDocument.defaultView?.Element ?? Element;
  host.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (!(target instanceof ElementClass)) return;
      if (target.matches("textarea#documentTitle")) {
        const title = target as HTMLTextAreaElement;
        if (/[\r\n]/.test(title.value)) title.value = title.value.replace(/[\r\n]+/g, " ");
      }
      if (!target.closest(".document-rich-shell")) actions.capture();
    },
    { signal },
  );
  host.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing) return;
      if (
        event.key === "Enter" &&
        event.target instanceof ElementClass &&
        event.target.matches("textarea#documentTitle")
      ) {
        event.preventDefault();
        actions.focus();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void actions.save().catch(actions.error);
      }
    },
    { signal },
  );
  host.addEventListener(
    "click",
    (event) => {
      const trigger =
        event.target instanceof ElementClass ? event.target.closest<HTMLButtonElement>("[data-doc-action]") : null;
      if (!trigger || trigger.disabled) return;
      const menu = trigger.closest<HTMLDetailsElement>(".document-editor-more");
      if (menu) {
        menu.open = false;
        if (menu.classList.contains("creative-reader-more"))
          menu.querySelector("summary")?.focus({ preventScroll: true });
      }
      void actions.action(trigger.dataset.docAction || "").catch(actions.error);
    },
    { signal },
  );
}
