import createDOMPurify from "dompurify";

const windows = new WeakMap();
const forbiddenTags = ["style", "script", "iframe", "object", "embed", "base", "link", "meta"];

function sanitizer(kind, window = globalThis.window) {
  if (!window?.document) throw new Error("HTML rendering requires a supported DOMPurify environment");
  let policies = windows.get(window);
  if (!policies) windows.set(window, (policies = new Map()));
  if (!policies.has(kind)) {
    const purifier = createDOMPurify(window);
    if (!purifier.isSupported) throw new Error("HTML rendering requires a supported DOMPurify environment");
    if (kind === "rich")
      purifier.addHook("uponSanitizeAttribute", (_node, attribute) => {
        // Model output must never acquire application-owned translation bindings.
        if (attribute.attrName.startsWith("data-pf-")) attribute.keepAttr = false;
      });
    policies.set(kind, purifier);
  }
  return policies.get(kind);
}

/** Internal UI may retain its message bindings, forms, SVG icons and stable IDs. */
export function sanitizeInterfaceHtml(html, ownerWindow = globalThis.window) {
  return sanitizer("interface", ownerWindow).sanitize(String(html ?? ""), {
    FORBID_TAGS: forbiddenTags,
    FORBID_ATTR: ["srcdoc", "action", "formaction"],
    ADD_ATTR: ["target", "rel"],
    RETURN_TRUSTED_TYPE: false,
  });
}

/** Untrusted rich text is cleaned after every link, image and math transform. */
export function sanitizeRichText(html, { allowStyles = false, allowImageButtons = false } = {}) {
  return sanitizer("rich").sanitize(String(html ?? ""), {
    FORBID_TAGS: [
      ...forbiddenTags,
      "form",
      "input",
      "textarea",
      "select",
      "option",
      ...(allowImageButtons ? [] : ["button"]),
    ],
    FORBID_ATTR: [
      "srcdoc",
      "action",
      "formaction",
      "id",
      "name",
      "autofocus",
      "tabindex",
      "contenteditable",
      ...(allowStyles ? [] : ["style"]),
    ],
    ADD_ATTR: ["target", "rel"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sandbox):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    RETURN_TRUSTED_TYPE: false,
  });
}
