// Reading anchors belong to visible content, not the height of an entire response.
const blocks = "p, pre, li, h1, h2, h3, h4, h5, h6, tr, blockquote, img";
const identities = ["data-item-id", "data-turn-id", "data-user-turn-id"];

/** @param {Element} owner @param {Element} target */
function childPath(owner, target) {
  const path = [];
  for (let node = target; node !== owner;) {
    const parent = node.parentElement;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return path;
}

/** @param {HTMLElement} root */
export function captureConversationAnchor(root) {
  const bounds = root.getBoundingClientRect();
  if (!root.clientHeight) return null;
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
  };
  for (const attribute of identities) {
    for (const owner of root.querySelectorAll(`[${attribute}]`)) {
      if (!visible(owner)) continue;
      const target = [...owner.querySelectorAll(blocks)].find(visible) || owner;
      const references = [owner];
      const turn = owner.closest("[data-turn-id], [data-user-turn-id]");
      if (turn && turn !== owner) references.push(turn);
      return {
        target,
        tag: target.tagName,
        text: (target.textContent || "").slice(0, 80),
        offset: target.getBoundingClientRect().top - bounds.top,
        top: root.scrollTop,
        references: references.map((node) => {
          const key = identities.find((name) => node.hasAttribute(name)) || attribute;
          return {
            node,
            selector: `[${key}="${CSS.escape(node.getAttribute(key) || "")}"]`,
            path: childPath(node, target),
            offset: node.getBoundingClientRect().top - bounds.top,
          };
        }),
      };
    }
  }
  return null;
}

/** @param {HTMLElement} root @param {NonNullable<ReturnType<typeof captureConversationAnchor>>} anchor */
export function conversationAnchorTop(root, anchor) {
  const top = root.getBoundingClientRect().top;
  if (root.contains(anchor.target) && anchor.target.getBoundingClientRect().height)
    return root.scrollTop + anchor.target.getBoundingClientRect().top - top - anchor.offset;
  const matches = (node) => node?.tagName === anchor.tag && (node.textContent || "").startsWith(anchor.text);
  let fallback = anchor.top;
  for (const reference of anchor.references) {
    const owner = root.contains(reference.node) ? reference.node : root.querySelector(reference.selector);
    if (!owner || !owner.getBoundingClientRect().height) continue;
    /** @type {Element | undefined} */
    let target = owner;
    for (const index of reference.path) target = target?.children[index];
    // Identity aliases can replace an item during history recovery. Resolve the
    // same paragraph inside its stable turn before falling back to the turn edge.
    if (!matches(target)) target = [...owner.querySelectorAll(blocks)].find(matches);
    if (target?.getBoundingClientRect().height)
      return root.scrollTop + target.getBoundingClientRect().top - top - anchor.offset;
    fallback = root.scrollTop + owner.getBoundingClientRect().top - top - reference.offset;
  }
  return fallback;
}
