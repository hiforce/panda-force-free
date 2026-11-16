import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import TextAlign from "@tiptap/extension-text-align";
import { richImageId } from "./rich-body.js";

/** The canonical node schema is shared; browser-only toolbars and upload state stay outside persisted content. */
export function documentEditorExtensions(options: { codeBlock?: false } = {}) {
  const ManagedImage = Image.extend({
    parseHTML() {
      return [
        {
          tag: "img[src]",
          getAttrs: (element) => {
            try {
              richImageId((element as HTMLElement).getAttribute("src"));
              return {};
            } catch {
              return false;
            }
          },
        },
      ];
    },
  });
  return [
    StarterKit.configure({
      ...(options.codeBlock === false ? { codeBlock: false } : {}),
      link: { openOnClick: false, autolink: false },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    TableKit.configure({ table: { resizable: true } }),
    ManagedImage.configure({ allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
  ];
}
