import { reportDiagnostic } from "../../shared/diagnostics.js";

// One registry per application. Registration is explicit and deterministic; no
// renderer is selected by executable content or arbitrary remote module URLs.
/** @param {readonly import("./types.js").ConversationRenderer[]} definitions */
export function createConversationRendererRegistry(definitions) {
  const ids = new Set();
  /** @type {Map<string, import("./types.js").ConversationRenderer[]>} */
  const byType = new Map();
  /** @type {WeakMap<HTMLElement, import("./types.js").ConversationRenderer>} */
  const owners = new WeakMap();
  for (const renderer of definitions) {
    if (!renderer.id || ids.has(renderer.id)) throw new Error(`Duplicate conversation renderer: ${renderer.id}`);
    ids.add(renderer.id);
    for (const type of renderer.types) {
      const candidates = byType.get(type) || [];
      if (candidates.some((candidate) => !candidate.matches))
        throw new Error(`Renderer ${renderer.id} is unreachable for ${type}`);
      candidates.push(renderer);
      byType.set(type, candidates);
    }
  }
  /** @param {HTMLElement} node */
  function release(node) {
    const renderer = owners.get(node);
    owners.delete(node);
    try {
      renderer?.dispose?.(node);
    } catch (error) {
      reportDiagnostic("conversation-renderer-dispose", error);
    }
  }
  return {
    /** @param {import("./types.js").ConversationRenderContext["item"]} item */
    resolve(item) {
      return byType.get(item.type)?.find((renderer) => !renderer.matches || renderer.matches(item)) || null;
    },
    /** @param {import("./types.js").ConversationRenderer} renderer @param {import("./types.js").ConversationRenderContext} context */
    render(renderer, context) {
      const previous = context.element;
      const owner = previous && owners.get(previous);
      if (owner && owner !== renderer) release(previous);
      const node = renderer.render(context);
      if (previous && previous !== node) release(previous);
      if (node && renderer.itemRoot !== false) owners.set(node, renderer);
      return node;
    },
    release,
  };
}
