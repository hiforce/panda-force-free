import type { Translate } from "../../../shared/i18n/messages.js";
import { codeBlockPhrases } from "./phrases.js";
import { CodeBlockControls } from "./controls.js";
import { loadDocumentCodeReader } from "./reader-loader.js";
/** Static code is immediately readable and copyable. Highlighting upgrades only these blocks and never evaluates the rich editor. */
export function enhanceReadingCodeBlocks(root: HTMLElement, t: Translate, error: (reason: unknown) => void) {
  let live = true;
  const blocks = [...root.querySelectorAll<HTMLPreElement>("pre")]
    .filter((pre) => pre.querySelector("code"))
    .map((pre) => {
      const code = pre.querySelector("code")!,
        text = code.textContent || "",
        language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) || "plaintext";
      const wrapper = document.createElement("div"),
        output = document.createElement("div");
      wrapper.className = "document-code-block";
      wrapper.dataset.codeBlockLanguage = language;
      let reader: { setWrap(value: boolean): void; destroy(): void } | null = null;
      const controls = new CodeBlockControls(t, {
        text: () => text,
        language: () => language,
        editable: () => false,
        setLanguage() {},
        setWrap(value) {
          pre.style.whiteSpace = value ? "pre-wrap" : "pre";
          reader?.setWrap(value);
        },
        error,
      });
      pre.replaceWith(wrapper);
      pre.dataset.codeStatic = "";
      pre.style.whiteSpace = controls.wrap ? "pre-wrap" : "pre";
      wrapper.append(controls.element, pre, output);
      return {
        wrapper,
        pre,
        text,
        language,
        output,
        controls,
        get reader() {
          return reader;
        },
        attach(value: typeof reader) {
          reader = value;
        },
      };
    });
  const upgrade = (block: (typeof blocks)[number]) => {
    void loadDocumentCodeReader()
      .then((runtime) => {
        if (!live || !root.isConnected || block.reader) return;
        const canvas = root.closest<HTMLElement>(".document-canvas"),
          top = canvas?.scrollTop;
        block.attach(
          runtime.createCodeReader(block.output, block.text, block.language, block.controls.wrap, codeBlockPhrases(t)),
        );
        block.pre.hidden = true;
        if (canvas && top !== undefined) canvas.scrollTop = top;
      })
      .catch(() => {
        /* Escaped code and its controls remain usable when the optional highlighter cannot load. */
      });
  };
  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              if (entry.isIntersecting) {
                observer!.unobserve(entry.target);
                const block = blocks.find((value) => value.wrapper === entry.target);
                if (block) upgrade(block);
              }
          },
          { rootMargin: "240px" },
        );
  for (const block of blocks) {
    if (observer) observer.observe(block.wrapper);
    else upgrade(block);
  }
  return {
    destroy() {
      live = false;
      observer?.disconnect();
      for (const block of blocks) {
        block.controls.close();
        block.reader?.destroy();
      }
    },
  };
}
